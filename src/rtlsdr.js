/*
  implement a plan for an rtlsdr device

  This object represents a plugged-in rtlsdr device and associated plan.
  As soon as it is created, it begins applying the plan.  This means:
  - issuing VAH commands to start the device (on whatever schedule)
  - issuing shell commands to set device parameters (on whatever schedule)
  - respond to "devRemoved" messages by shutting down
  - respond to "devStalled" messages by and resetting + restarting the
    device

  Most of the work is done by a modified version of rtl_tcp, to which
  we establish two half-duplex connections.  rtl_tcp listens to the
  first for commands to start/stop streaming and set tuning and
  filtering parameters.  rtl_tcp sends streamed samples down the
  second connection.  The first connection is from nodejs, running
  this module.  Commands are sent to that connection, and it replies
  with a JSON-formatted list of current parameter settings.

  The second connection is opened by vamp-alsa-host, after we ask it
  to "open" the rtlsdr device.  We watch for the death of vamp-alsa-host
  in which case we need to restart rtl_tcp, since its only handles
  two connections and dies after noticing either has closed.

  Parameters settings accepted by rtl_tcp are all integers; this module
  is responsible for converting to/from natural units.
  example:

    parameter    rtl_tcp unit    "natural unit"
                   (integer)    (floating point)
   ---------------------------------------------
    frequency     166370000        166.376 MHz
    tuner_gain       105             10.5 dB

  "Natural units" are used in deployment.txt, the web interface, and
  the matron's "setParam" messages.

*/

var enableAGC = false; // automatic gain control

RTLSDR = function(matron, dev, devPlan) {
    Sensor.Sensor.call(this, matron, dev, devPlan);
    // path to the socket that rtl_tcp will use
    // e.g. /tmp/rtlsdr-1:4.sock for a device with usb path 1:4 (bus:dev)
    this.sockPath = "/tmp/rtlsdr-" + dev.attr.usbPath + ".sock";
    // path to rtl_tcp
    this.prog = "/usr/local/bin/rtl_tcp";

    // hardware rate needed to achieve plan rate;
    // same algorithm as used in vamp-alsa-host/RTLSDRMinder::getHWRateForRate
    // i.e. find the smallest exact multiple of the desired rate that is in
    // the allowed range of hardware rates.

    var rate = devPlan.plan.rate;
    if (rate <= 0 || rate > 3200000) {
        console.log("rtlsdr: requested rate not within hardware range; using 48000");
        rate = 48000;
    }

    this.hw_rate = rate;
    while (!(this.hw_rate >= 225001 && this.hw_rate <= 300000) && !(this.hw_rate >= 900001 && this.hw_rate <= 3200000)) {
        this.hw_rate += rate;
    }

    // callback closures
    this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    this.this_logServerError   = this.logServerError.bind(this);
    this.this_VAHdied          = this.VAHdied.bind(this);
    this.this_VAHdata          = this.VAHdata.bind(this);
    this.this_serverDied       = this.serverDied.bind(this);
    this.this_serverError      = this.serverError.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    //this.this_cmdSockError     = this.cmdSockError.bind(this);
    this.this_cmdSockClose     = this.cmdSockClose.bind(this);
    //this.this_cmdSockEnd       = this.cmdSockEnd.bind(this);
    this.this_spawnServer      = this.spawnServer.bind(this);

    // handle situation where program owning other connection to rtl_tcp dies
    this.matron.on("VAHdied", this.this_VAHdied);

    // listen to data to adjust gain based on noise level
    this.matron.on("vahData", this.this_VAHdata);

    // storage for the setting list sent by rtl_tcp
    this.replyBuf = ""; // buffer the reply stream, in case it crosses transmission unit boundaries

    // rtl_tcp replies with a 12-byte header, before real command replies; we ignore this
    // as the info is available elsewhere
    this.gotCmdHeader = false;

    this.restart = false; // when true, we're killing the server and want a restart

    this.killing = false; // when true, we've deliberately killed the server

    this.agc_at = 0; // timestamp of last AGC change

    console.log("rtlsdr: created");
};

RTLSDR.prototype = Object.create(Sensor.Sensor.prototype);
RTLSDR.prototype.constructor = RTLSDR;

RTLSDR.prototype.rtltcpCmds = {
    // table of command recognized by rtl_tcp
    //
    // - the command is sent as a byte, followed by a big-endian 32-bit parameter
    //
    // - units for parameters below are those understood by rtl_tcp, and are integers
    //
    // - parameters have the same name in deployment.txt, but some of the units
    //   differ there, since they are allowed to be reals.

    frequency:          1, // listening frequency;  units: Hz; (deployment.txt units: MHz)
    rate:               2, // sampling rate, in Hz
    gain_mode:          3, // whether or not to allow tuner gains to be set (0 = no, 1 = yes)
    tuner_gain:         4, // units: 0.1 dB (deployment.txt units: dB)
    freq_correction:    5, // in units of ppm; we don't use this

    // gains for IF stages are sent using the same command; the stage # is encoded in the upper 16 bits of the 32-bit parameter
    // only the E4000 tuner supports these, for details see https://hz.tools/e4k/
    if_gain1:           6, // IF stage 1 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain2:           6, // IF stage 2 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain3:           6, // IF stage 3 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain4:           6, // IF stage 4 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain5:           6, // IF stage 5 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain6:           6, // IF stage 6 gain; units: 0.1 dB (deployment.txt units: dB)

    test_mode:          7, // send counter instead of real data, for testing (0 = no, 1 = yes)
    agc_mode:           8, // automatic digital gain control (0 = no, 1 = yes) in rtl2832
    direct_sampling:    9, // sample RF directly, rather than IF stage; 0 = no, 1 = yes (not for radio frequencies above 10 MHz)
    offset_tuning:     10, // detune away from exact carrier frequency, to avoid deadzone in some tuners; 0 = no, 1 = yes
    rtl_xtal:          11, // set use of crystal built into rtl8232 chip? (vs off-chip tuner); 0 = no, 1 = yes
    tuner_xtal:        12, // set use of crystal on tuner (vs off-board tuner); 0 = no, 1 = yes
    tuner_gain_index:  13, // tuner gain setting by index into array of possible values; array size is returned when first connecting to rtl_tcp
    bias_tee:          14, // bias tee control 0=off, 1=on
    streaming:         96  // have rtl_tcp start (1) or stop (0) submitting URBs and sending sample data to other connection
};

RTLSDR.prototype.hw_devPath = function() {
    // the device path parsable by vamp-alsa-host/RTLMinder;
    // it looks like rtlsdr:/tmp/rtlsdr-1:4.sock
    return "rtlsdr:" + this.sockPath;
};

RTLSDR.prototype.hw_init = function(callback) {
    //console.log("calling hw_init on rtlsdr");
    this.initCallback = callback;
    this.spawnServer();   // launch the rtl_tcp process
};

RTLSDR.prototype.spawnServer = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
    //console.log("about to delete command socket with path: " + this.sockPath);
    try {
        // Note: node throws on this call if this.sockPath doesn't exist;
        Fs.unlinkSync(this.sockPath);
    } catch (e) {
        //console.log("Error removing command socket: " + e.toString());
    };

    // set the libusb buffer size so it holds approximately 100 ms of I/Q data
    // We round up to the nearest multiple of 512 bytes, as required by libusb
    var usb_buffer_size = this.hw_rate * 2 * 0.100;
    usb_buffer_size = 512 * Math.ceil(usb_buffer_size / 512.0);

    var args = ["-p", this.sockPath, "-d", this.dev.attr.usbPath, "-s", this.hw_rate, "-B", usb_buffer_size];
    console.log("RTLSDR spawning server: " + this.prog + " " + args.join(" "));
    var server = ChildProcess.spawn(this.prog, args, { 'shell': false });
    server.on("close", this.this_serverDied);
    server.on("error", this.this_serverError);
    server.stdout.on("data", this.this_serverReady);
    server.stderr.on("data", (data) => console.log("RTLSDR server stderr: " + data.toString().trim()));
    server.stderr.on("close", () => console.log("RTLSDR server stderr closed"));
    this.server = server;
};

RTLSDR.prototype.serverReady = function(data) {
    if (this.inDieHandler)
        return;
    console.log("RTLSDR server stdout: " + data.toString().trim());
    if (data.toString().match(/Listening/)) {
        if(this.server) {
            this.server.stdout.removeListener("data", this.this_serverReady);
            this.connectCmd();
        }
    }
};

RTLSDR.prototype.connectCmd = function() {
    // server is listening for connections, so connect
    console.log("RTLSDR connected to rtl_tcp server");
    if (this.cmdSock || this.inDieHandler) {
        return;
    }
    //console.log("connecting command socket with path: " + this.sockPath);
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("close" , this.this_cmdSockClose);
    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

// RTLSDR.prototype.cmdSockError = function(e) {
//     if (! e)
//         return;
//     console.log("Got command socket error " + e.toString());
//     if (this.cmdSock) {
//         this.cmdSock.destroy();
//         this.cmdSock = null;
//     }
//     if (this.quitting || this.inDieHandler)
//         return;
//     setTimeout(this.this_hw_stalled, 5001);
// };

// RTLSDR.prototype.cmdSockEnd = function(e) {
//     if (! e)
//         return;
//     console.log("Got command socket end " + e.toString());
//     if (this.cmdSock) {
//         this.cmdSock.destroy();
//         this.cmdSock = null;
//     }
//     if (this.quitting || this.inDieHandler)
//         return;
//     setTimeout(this.this_hw_stalled, 5001);
// };

RTLSDR.prototype.cmdSockClose = function(e) {
    if (!e )
        return;
    //console.log("Got command socket close " + e.toString());
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

RTLSDR.prototype.cmdSockConnected = function() {
    // process any queued command
    //console.log("Got command socket connected");
    if (this.initCallback) {
        var cb = this.initCallback;
        this.initCallback = null;
        cb();
    }
};

RTLSDR.prototype.VAHdied = function() {
    this.hw_delete();
};

RTLSDR.prototype.serverError = function(err) {
    console.log("rtl_tcp server got error: " + JSON.stringify(err))
};

RTLSDR.prototype.serverDied = function(code, signal) {
    console.log("rtl_tcp server died, code:" + code + " signal:" + signal)
    this.server = null
    this.close() // in Sensor
    if (!this.killing) {
        console.log("rtl_tcp server died, code:" + code + " signal:" + signal)
        this.matron.emit('devState', this.dev.attr?.port, "error", `rtl_tcp server died, exit code ${code}`)
    }
    // restart if we said so, or the process exited with non-zero status and not due to a signal
    //if (this.restart || (code && !signal)) this.hw_restart();
    if (this.restart || !signal) this.hw_restart();
};

RTLSDR.prototype.hw_delete = function() {
    //console.log("rtlsdr::hw_delete");
    if (this.server) {
        this.killing = true;
        this.server.kill("SIGKILL");
        console.log("rtl_tcp server", this.server.pid, this.server.killed ? "killed" : "not killed");
        //this.server = null;
    }
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
};

RTLSDR.prototype.hw_startStop = function(on) {
    // just send the 'streaming' command with appropriate value
    this.hw_setParam({par:"streaming", val:on?1:0});
    console.log("rtlsdr::hw_startStop = " + on);
};

// hw_restart is called when either data from the device seems to have stalled
// (which can be due to chrony stepping the clock forward) or when rtl_tcp has died
RTLSDR.prototype.hw_restart = function() {
    // pretend the device has been removed then added, this will trigger deletion of all resources
    // and then relaunch of rtl_tcp.
    console.log("rtlsdr::hw_reset - faking a remove & re-add");
    // copy the device structure (really - this is the best node has to offer for cloning POD?)
    var dev = JSON.parse(JSON.stringify(this.dev));
    // re-add after 5 seconds
    setTimeout(function(){TheMatron.emit("devAdded", dev)}, 5000);
    // remove now
    this.matron.emit("devRemoved", this.dev);
};

RTLSDR.prototype.hw_stalled = function() {
    // relaunch rtl_tcp and re-establish connection
    console.log("rtlsdr::hw_stalled");
    this.restart = true
    this.hw_delete()
};

// tune gain to set the noise floor into the -35..-45dB range
RTLSDR.prototype.VAHdata = function(line) {
    if (exports.enableAGC && line.startsWith("p"+this.dev.attr?.port) && Date.now()-this.agc_at > 60_000) {
        // lotek data
        const ll = line.trim().split(',')
        if (ll.length < 6) return
        const noise = parseFloat(ll[4])
        if (!Number.isFinite(noise) || noise > -10 || noise < -1000) return
        if (noise >= -45 && noise <= -35) return
        // should adjust gain, get info together
        var dev = HubMan.getDevs()[this.dev.attr.port];
        const tgv = dev?.settings?.tuner_gain_values
        if (!Array.isArray(tgv)) return
        const gain = dev?.settings?.tuner_gain
        if (!Number.isFinite(gain)) return
        let ix
        if (noise > -35) {
            // noise too high, need to turn gain down
            ix = tgv.findLastIndex(v => v < gain)
        } else if (noise < -45) {
            // noise too low, need to turn gain up
            ix = tgv.findIndex(v => v > gain)
        }
        if (ix >= 0) {
            console.log(`RTLSDR: adjusting gain for P${this.dev.attr.port} from ${gain} to ${tgv[ix]}dB, noise is ${noise}dB`)
            this.hw_setParam({par:'tuner_gain', val:tgv[ix]})
            this.agc_at = Date.now()
            FlexDash.set(`rtl_sdr_gain/${this.dev.attr.port}`, tgv[ix])
        }     
    }
    FlexDash.set('detections_5min', this.detections)
};

RTLSDR.prototype.hw_setParam = function(parSetting, callback) {
    // create the 5-byte command and send it to the socket
    var cmdBuf = Buffer.alloc(5);
    var par = parSetting.par, val = parSetting.val;

    // fix up any parameter values to match rtl_tcp semantics

    switch (par) {
    case "frequency":
        // convert from MHz to Hz
        val = Math.round(val * 1.0E6);
        break;
    case "tuner_gain":
        // convert from dB to 0.1 dB
        FlexDash.set(`rtl_sdr_gain/${this.dev.attr.port}`, val)
        val = Math.round(val * 10);
        break;
    case "if_gain1":
    case "if_gain2":
    case "if_gain3":
    case "if_gain4":
    case "if_gain5":
    case "if_gain6":
        // encode gain stage in upper 16 bits of value, convert dB to 0.1 dB in lower 16 bits
        val = ((par.charCodeAt(7)-48) << 16) + Math.round(val * 10);
        break;
    }
    var cmdNo = this.rtltcpCmds[parSetting.par];
    if (cmdNo && this.cmdSock) {
        console.log(`RTLSDR: set parameter ${par} (${cmdNo}) to ${val}`);
        try {
            cmdBuf.writeUInt8(cmdNo, 0);
            cmdBuf.writeUInt32BE(val, 1); // note: rtl_tcp expects big-endian
            this.cmdSock.write(cmdBuf, callback);
        } catch(e) {
            this.matron.emit("setParamError", {type:"rtlsdr", port: this.dev.attr.port, par: par, val:val, err: e.toString()})
        }
    };
};

RTLSDR.prototype.logServerError = function(data) {
    console.log("rtl_tcp got error: " + data.toString().trim());
};

RTLSDR.prototype.gotCmdReply = function(data) {

    // rtl_tcp command replies are single JSON-formatted objects on a
    // single line ending with '\n'.  Although the reply should fit in
    // a single transmission unit, and so be completely contained in
    // the 'data' parameter from a single call to this function, we
    // play it safe and treat the replies as a '\n'-delimited stream
    // of JSON strings, parsing each complete string into
    // this.dev.settings


    // skip the 12 byte header
    this.replyBuf += data.toString('utf8', this.gotCmdHeader ? 0 : 12);
    // console.log("gotCmdReply: " + data.toString('utf8', this.gotCmdHeader ? 0 : 12));
    this.gotCmdHeader = true;
    for(;;) {
	var eol = this.replyBuf.indexOf("\n");
	if (eol < 0)
	    break;
        var replyString = this.replyBuf.substring(0, eol);
	this.replyBuf = this.replyBuf.substring(eol + 1);
        var dev = HubMan.getDevs()[this.dev.attr.port];
        if (dev) {
            dev.settings = JSON.parse(replyString);
            for (p in dev.settings) {
                var val = dev.settings[p];
                switch (p) {
                case "frequency":
                    // convert to MHz from Hz
                    val = val / 1.0E6;
                    break;
                case "tuner_gain":
                case "if_gain1":
                case "if_gain2":
                case "if_gain3":
                case "if_gain4":
                case "if_gain5":
                case "if_gain6":
                    // convert to dB from 0.1 dB
                    val = val / 10.0;
                    break;
                };
                dev.settings[p] = val;
            }
            this.matron.emit('rtlInfo', this.dev.attr?.port, {...dev.settings})
        }
    }
};

exports.RTLSDR = RTLSDR;
exports.enableAGC = enableAGC;
