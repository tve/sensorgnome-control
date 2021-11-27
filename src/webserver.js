/*

  webserver.js - a singleton class providing a web interface to the SensorGnome

  required Globals: WavMaker, Deployment, Machine, GPS

*/

var Express = require('express'),
    Connect = require('connect'),
    Multer = require('multer'),  // multi-part upload middleware
    MethodOverride = require('method-override'),
    ErrorHandler = require('errorhandler'),
    Io = require('socket.io'),
    Http = require('http');
Morgan = require("morgan")  // request logger middleware

function WebServer(matron) {
    this.matron = matron;
    this.sock = null;
    this.app = null;
    this.server = null;
    this.io = null;
    this.vahPushTimeout = null;
    this.haveRegisteredListeners = false;
    this.rawStream = null;

    // callback closures

    this.this_clientDisconnected = this.clientDisconnected.bind(this);
    this.this_deviceInfoChanged = this.deviceInfoChanged.bind(this);
    this.this_getRawAudio = this.getRawAudio.bind(this);
    this.this_gotDevStatusForRawAudio = this.gotDevStatusForRawAudio.bind(this);
    this.this_handleWebConnection = this.handleWebConnection.bind(this);
    this.this_pushData = this.pushData.bind(this);
    this.this_pushTag = this.pushTag.bind(this);
    this.this_pushParam = this.pushParam.bind(this);
    this.this_pushTagDB = this.pushTagDB.bind(this);
    this.this_pushDeviceInfo = this.pushDeviceInfo.bind(this);
    this.this_pushGPSFix = this.pushGPSFix.bind(this);
    this.this_requestedGPSFix = this.requestedGPSFix.bind(this);
    this.this_pushLSFiles = this.pushLSFiles.bind(this);
    this.this_pushSGBooted = this.pushSGBooted.bind(this);
    this.this_pushVAHStatus = this.pushVAHStatus.bind(this);
    this.this_requestedLSFiles = this.requestedLSFiles.bind(this);
    this.this_requestedSGBoot = this.requestedSGBoot.bind(this);
    this.this_requestedVAHStatus = this.requestedVAHStatus.bind(this);
    this.this_requestedTagDB = this.requestedTagDB.bind(this);
    this.this_requestedSetParam = this.requestedSetParam.bind(this);
    this.this_setParamError = this.setParamError.bind(this);
    this.this_requestedSetClock = this.requestedSetClock.bind(this);
    this.this_softwareUpdateUploadCompleted = this.softwareUpdateUploadCompleted.bind(this);
    this.this_uploadSoftwareUpdate = this.uploadSoftwareUpdate.bind(this);

    // ===== Event listeners for FlexDash

    for (const ev of ['gps', 'chrony']) {
        this.matron.on(ev, (...args) => {
            if (args.length <= 1) FlexDash.set(ev, ...args)
            else FlexDash.set(ev, args)
        })
    }
    // this.matron.on('gotTag', this.this_pushTag);
    // this.matron.on('setParam', this.this_pushParam);
    // this.matron.on('setParamError', this.this_setParamError);
    this.matron.on('devAdded', (info) => { FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info)) })
    this.matron.on('devRemoved', (info) => { FlexDash.unset(`devices/${info.attr.port}`) });
    // this.matron.on('vahData', this.this_pushData);
};

// function for ignoring response from e.g. a childprocess

WebServer.prototype.ignore = function (error, stdout, stderr) { };

WebServer.prototype.uploadSoftwareUpdate = function (req, res) {
    var updateFileDest = "/boot/uboot/sensorgnome_update.tar.bz2";
    try {
        Fs.unlinkSync(updateFileDest);
    } catch (e) {
    }
    console.log(JSON.stringify(req.files));
    Fs.writeFileSync(updateFileDest, Fs.readFileSync(req.files[0].path));
    Fs.unlinkSync(req.files[0].path);
    var reply = "Uploaded software update to " + updateFileDest + " (size = " + req.files[0].size + " bytes)<br>Flushing buffers - this may take a while.<br><b>Please <blink>do not disconnect</blink> until I'm finished</b>";
    res.send(reply);
    ChildProcess.exec("sync", this.this_softwareUpdateUploadCompleted);
}

WebServer.prototype.softwareUpdateUploadCompleted = function (err, stdout, stderr) {
    if (this.sock)
        this.sock.emit('softwareUpdateResults', "I finished writing the software update to disk.<br>It will take effect the next time your SensorGnome is rebooted.");
};

WebServer.prototype.getRawAudio = function (req, res) {
    // reply to requests for /raw_audio?dev=LABEL&fm=1
    // (dev specifies a device label; fm specifies whether or not to FM-demodulate data)
    // We stream raw audio from the device in one-hour
    // .WAV file chunks.  We always stream in mono at 48 kHz


    VAH.vahSubmit("status " + req.query.dev, this.this_gotDevStatusForRawAudio, { req: req, res: res });
};

WebServer.prototype.gotDevStatusForRawAudio = function (dev, reqres) {
    var req = reqres.req,
        res = reqres.res,
        port = req.query.dev;

    if (!dev.type || (dev.type != "DevMinder")) {
        res.end("No such audio device: " + port);
        return;
    }

    // hardcoded stream time, channels, rate, and bits per sample
    var rate = 48000;
    var numChan = 1;
    var bitsPerSample = 16; // fixme: hard-coded S16_LE
    var secsPerWavFile = 3600; // write one hour at a time to the WAV file

    // resulting file size, including 44-byte header:
    var numBytes = rate * numChan * bitsPerSample * secsPerWavFile / 8 + 44;

    var doFM = parseInt(req.query.fm);

    if (this.rawStream) {
        this.rawStream.stop();
        this.rawStream.destroy();
        delete this.rawStream;
    }

    res.writeHead(206, "Partial Content", {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-" + (numBytes - 1) + "/" + numBytes,
        "Keep-Alive": "timeout=60, max=100",
        "Connection": "Keep-Alive",
        "Content-Type": "audio/x-wav"
    });

    this.rawStream = VAH.getRawStream(port, rate, doFM);
    this.rawStream.pipe(res);
    this.rawStream.start();
};

// Push device change info

WebServer.prototype.pushDeviceInfo = function (err, stdout, stderr) {
    if (this.sock && !err) {
        // get basic info from the perl script (yuck!)
        var info = JSON.parse(stdout.toString());
        // splice in any ".settings" fields from HubMan
        // FIXME: HubMan should be maintaining all of this

        var devs = HubMan.getDevs();
        for (d in devs) {
            if (info[d] && devs[d]) // got errors where devs[d] is null !?
                info[d].settings = devs[d].settings
            else if (info[d])
                console.log("Ooops: devs[d] is null? d=" + d + " info[d]=" + JSON.stringify(info[d]));
        }
        this.sock.emit('devinfo', info);
    }
}

WebServer.prototype.deviceInfoChanged = function () {
    ChildProcess.exec("/opt/sensorgnome/udev-usb/get-hub-devices.py", this.this_pushDeviceInfo);
}

WebServer.prototype.pushLSFiles = function (err, stdout, stderr) {
    if (this.sock && !err) {
        this.sock.emit('lsdata', stdout.toString());
    }
}

WebServer.prototype.requestedSetParam = function (data) {
    this.matron.emit("requestSetParam", data);
};

WebServer.prototype.requestedSetClock = function (data) {
    d = parseFloat(data.toString());
    if (isFinite(d))
        ChildProcess.exec("/bin/date -u -s@" + d + "; hwclock --systohc -u -f /dev/rtc1", this.ignore);
};

WebServer.prototype.requestedLSFiles = function () {
    ChildProcess.exec("/bin/ls -lLtR /media/*/SGdata", { maxBuffer: 2000000 }, this.this_pushLSFiles);
};

WebServer.prototype.pushPlan = function () {
    if (this.sock) {
        this.sock.emit('plan', { planPath: Deployment.planPath, planText: Deployment.planText });
    }
};

WebServer.prototype.requestedTagDB = function () {
    if (!this.matron.tagDBFile)
        this.this_pushTagDB("No tag database file found");
    else if (this.matron.tagDBFile.match(/sqlite$/))
        ChildProcess.exec("/usr/bin/sqlite3 " + this.matron.tagDBFile + " 'select proj,id,tagFreq,dfreq-1000*(tagFreq-fcdFreq) as dfreq,bi from tags order by proj,tagFreq,id,bi'", this.this_pushTagDB);
    else
        Fs.readFile(this.matron.tagDBFile, this.this_pushTagDB);
};

WebServer.prototype.pushTagDB = function (err, data) {
    if (this.sock) {
        let f = this.matron.tagDBFile ? Path.basename(this.matron.tagDBFile) : "";
        var obj = { err: err, file: f, data: data ? data.toString() : "ERROR" };
        this.sock.emit('tagDB', obj);
    }
};

WebServer.prototype.pushSGBooted = function (err, stdout, stderr) {
    if (this.sock) {
        try {
            this.sock.emit('sgbooted', true);
        } catch (e) {
            this.sock.emit('sgbooted', false);
        }
    }
};

WebServer.prototype.requestedSGBoot = function () {
    console.log("Requested sg-control restart\n");
    ChildProcess.exec("(sleep 3; sudo reboot) &", this.this_pushSGBooted);
}

WebServer.prototype.pushVAHStatus = function (data) {
    if (this.sock) {
        try {
            // add current date/time and time/GPS-related info
            data.date = (new Date()).getTime() / 1000;
            data.timeSource = GPS.timeSource;
            data.RMSError = GPS.RMSError != null ? Math.abs(GPS.RMSError) : null;
            data.GPSstate = GPS.GPSstate;
            this.sock.emit('vahstatus', data);
        } catch (e) {
            console.log("Unable to display status of vamp-alsa-server process!");
        }
        if (this.vahPushTimeout)
            clearTimeout(this.vahPushTimeout);
        this.vahPushTimeout = setTimeout(this.this_requestedVAHStatus, 2000);
    }
}

WebServer.prototype.requestedVAHStatus = function () {
    TheMatron.emit("vahSubmit", "list", this.this_pushVAHStatus);
}

WebServer.prototype.pushGPSFix = function (fix) {
    if (this.sock) {
        this.sock.emit('gpsfix', fix);
    };
    if (this.flexdash) this.flexdash.set('gps', fix);
};

WebServer.prototype.pushTag = function (x) {
    if (this.sock) {
        this.sock.emit('gotTag', x);
    };
};

WebServer.prototype.pushParam = function (x) {
    if (this.sock) {
        if (x.port)
            x.other = HubMan.getDevs()[x.port].settings;
        this.sock.emit('gotParam', x);
    };
};

WebServer.prototype.requestedGPSFix = function () {
    GPS.getFix();
};

WebServer.prototype.sendMachineInfo = function () {
    if (this.sock) {
        this.sock.emit('machineinfo', {
            machine: Machine,
            uptime: Fs.readFileSync("/proc/uptime").toString(),
        });
    }
};

WebServer.prototype.clientDisconnected = function () {
    console.log("WS client disconnected");
    if (this.sock) {
        this.matron.removeListener('gotGPSFix', this.this_pushGPSFix);
        this.matron.removeListener('gotTag', this.this_pushTag);
        this.matron.removeListener('setParam', this.this_pushParam);
        this.matron.removeListener('setParamError', this.this_setParamError);
        this.matron.removeListener("devAdded", this.this_deviceInfoChanged);
        this.matron.removeListener("devRemoved", this.this_deviceInfoChanged);
        this.matron.removeListener('vahData', this.this_pushData);
        this.haveRegisteredListeners = false;
        delete this.sock;
        this.sock = null;
    }
    if (this.rawStream) {
        this.rawStream.destroy();
        delete this.rawStream;
        this.rawStream = null;
    }
};

WebServer.prototype.pushData = function (data) {
    if (this.sock) {
        this.sock.emit('newVahData', data.toString());
    }
};

WebServer.prototype.setParamError = function (data) {
    if (this.sock) {
        this.sock.emit('setParamError', data);
    }
};

// Web Sockets

WebServer.prototype.handleWebConnection = function (socket) {
    console.log("WS client connected", socket.handshake.address);
    this.sock = socket;
    socket.on('disconnect', this.this_clientDisconnected);
    socket.on('error', this.this_clientDisconnected);
    socket.on('devinfo', this.this_deviceInfoChanged);
    socket.on('lsdata', this.this_requestedLSFiles);
    socket.on('sgboot', this.this_requestedSGBoot);
    socket.on('vahstatus', this.this_requestedVAHStatus);
    socket.on('gpsfix', this.this_requestedGPSFix);
    socket.on('getTagDB', this.this_requestedTagDB);
    socket.on('clientSetParam', this.this_requestedSetParam);
    socket.on('setclock', this.this_requestedSetClock);

    if (!this.haveRegisteredListeners) {
        this.matron.on('gotGPSFix', this.this_pushGPSFix);
        this.matron.on('gotTag', this.this_pushTag);
        this.matron.on('setParam', this.this_pushParam);
        this.matron.on('setParamError', this.this_setParamError);
        this.matron.on('devAdded', this.this_deviceInfoChanged);
        this.matron.on('devRemoved', this.this_deviceInfoChanged);
        this.matron.on('vahData', this.this_pushData);
        this.haveRegisteredListeners = true;
    };

    this.sendMachineInfo();
    GPS.getFix();
    this.pushPlan();
    this.deviceInfoChanged();
    //    this.requestedLSFiles();
    //    this.requestedVAHStatus();
    this.requestedTagDB();
};

WebServer.prototype.genDevInfo = function (dev) {
    var info = {
        port: dev.attr.port,
        port_path: dev.attr["port_path"] || "--",
        type: dev.attr.type,
    }
    switch (dev.attr.type) {
    case "gps": info.attr = dev.attr.kind; break
    case "CornellTagXCVR": info.attr = "433Mhz"; break
    case "funcubeProPlus": info.attr = "?Mhz"; break
    case "funcubePro": info.attr = "?Mhz"; break
    case "rtlsdr": info.type = dev.attr.prod; info.attr = "?Mhz"; break
    }
    return info
}

WebServer.prototype.start = function (flexdash) {
    this.flexdash = flexdash;

    this.app = Express();
    this.app.use(Morgan('tiny'))
    this.app.use(Multer({ dest: './uploads/' }).any());
    this.server = Http.createServer(this.app);
    this.io = new Io.Server(this.server);

    this.io.on('connection', this.this_handleWebConnection);

    // Configuration
    this.app.use(MethodOverride());
    this.app.use(Express.static(__dirname + '/public', { extensions: ['html'] }));

    // note: need to switch to using this.app.get('env')
    // this.app.configure('development', () => {
    //     this.app.use(ErrorHandler({ dumpExceptions: true, showStack: true }));
    // });
    // this.app.configure('production', () => {
    //     this.app.use(ErrorHandler());
    // });

    this.app.set('view options', { layout: false });

    //this.io.configure(() => { io.set('log level', 0) });

    // Routes
    this.app.get('/', (_, res) => res.sendfile("public/index.html"));
    this.app.post('/upload_software_update', this.this_uploadSoftwareUpdate);
    this.app.get('/raw_audio', this.this_getRawAudio);

    this.server.listen(80, () => {
        console.log("SensorGnome server listening on port %d in %s mode",
            this.server.address().port, this.app.settings.env);
    });

};

exports.WebServer = WebServer;
