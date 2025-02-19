/*

  vah.js - maintain a running instance of vamp-alsa-host and communicate
  with it.

  vamp-alsa-host accepts commands and sends replies over a unix domain
  connection.  It also outputs data from plugins or raw devices over a
  unix domain connection.

*/

VAH = function(matron, prog, sockName) {

    this.matron = matron;
    this.prog = prog;
    this.sockName = sockName;
    this.sockPath = "/tmp/" + sockName;
    this.cmdSock = null; // control socket
    this.dataSock = null; // data socket
    this.child = null; // child process
    this.replyHandlerQueue = []; // list of reply handlers in order of commands being sent out
                                 // each handler is an object with these fields:
                                 // callback: function(reply, par) to call with reply and extra parameter
                                 // par:  extra parameter for callback
                                 // n: number of times to use this handler

    this.commandQueue = []; // list of commands queued before command connection is established
    this.replyBuf = "";
    this.dataBuf = "";
    this.quitting = false;
    this.inDieHandler = false;
    this.connectCmdTimeout = null;
    this.connectDataTimeout = null;
    this.checkRateTimer = null;
    this.frames = {}; // last frame count&time for each plugin {at: Date.now(), frames:N, bad:N}

    // callback closures
    this.this_childDied        = this.childDied.bind(this);
    this.this_logChildError    = this.logChildError.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_connectData      = this.connectData.bind(this);
    this.this_doneReaping      = this.doneReaping.bind(this);
    this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    this.this_gotData          = this.gotData.bind(this);
    this.this_quit             = this.quit.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    this.this_cmdSockProblem   = this.cmdSockProblem.bind(this);
    this.this_dataSockProblem  = this.dataSockProblem.bind(this);
    this.this_spawnChild       = this.spawnChild.bind(this);
    this.this_vahAccept        = this.vahAccept.bind(this);
    this.this_vahSubmit        = this.vahSubmit.bind(this);
    this.this_vahStartStop     = this.vahStartStop.bind(this);

    matron.on("quit", this.this_quit);
    matron.on("vahSubmit", this.this_vahSubmit);
    matron.on("vahStartStop", this.this_vahStartStop);
    matron.on("vahAccept", this.this_vahAccept);

    this.reapOldVAHandSpawn();
}

// sample rate checker parameters
const checkRatesInterval = 10_000; // ms
const maxOutOfBounds = 2; // number of consecutive OOB checks that trigger a reset
const boundsPCT = 5; // nominal +/- bounds percentage

VAH.prototype.childDied = function(code, signal) {
//    console.log("VAH child died\n")
    if (this.inDieHandler)
        return;
    this.inDieHandler = true;
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (! this.quitting)
        setTimeout(this.this_spawnChild, 5000);
    if (this.connectCmdTimeout) {
        clearTimeout(this.connectCmdTimeout);
        this.connectCmdTimeout = null;
    }
    if (this.connectDataTimeout) {
        clearTimeout(this.connectDataTimeout);
        this.connectDataTimeout = null;
    }
    this.inDieHandler = false;
    this.matron.emit("VAHdied")
};

VAH.prototype.reapOldVAHandSpawn = function() {
    ChildProcess.execFile("/usr/bin/killall", ["-KILL", "vamp-alsa-host"], null, this.this_doneReaping);
    if (this.checkRateTimer)
        clearInterval(this.checkRateTimer);
};

VAH.prototype.doneReaping = function() {
    this.spawnChild();
};

VAH.prototype.spawnChild = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
    console.log("VAH launching", this.prog, "-q", "-s", this.sockName);
    var child = ChildProcess.spawn(this.prog, ["-q", "-s", this.sockName]);
    child.on("exit", this.this_childDied);
    child.on("error", this.this_childDied);
    child.stdout.on("data", this.this_serverReady);
    child.stderr.on("data", this.this_logChildError);
    this.child = child;
    this.frames = {};
};

VAH.prototype.cmdSockConnected = function() {
    // process any queued command
    while (this.commandQueue.length) {
        console.log("VAH command (queued): ", JSON.stringify(this.commandQueue[0]));
        this.cmdSock.write(this.commandQueue.shift());
    }
};

VAH.prototype.serverReady = function(data) {
    this.child.stdout.removeListener("data", this.this_serverReady);
    this.connectCmd();
    this.connectData();
    this.matron.emit("VAHstarted");
};

VAH.prototype.logChildError = function(data) {
    console.log("VAH stderr: " + data.toString().trim());
};

VAH.prototype.connectCmd = function() {
    // server is listening for connections, so connect
    if (this.cmdSock) {
        return;
    }
//    console.log("about to connect command socket\n")
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("error" , this.this_cmdSockProblem);
    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

VAH.prototype.connectData = function() {
    if (this.dataSock) {
        return;
    }
//    console.log("about to connect data socket\n")
    this.dataSock = Net.connect(this.sockPath, function() {});

    this.dataSock.on("error" , this.this_dataSockProblem);
    this.dataSock.on("data"  , this.this_gotData);
}

VAH.prototype.cmdSockProblem = function(e) {
    console.log("VAH: command socket problem " + e.toString());
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_connectCmd, 5001);
};

VAH.prototype.dataSockProblem = function(e) {
    console.log("VAH: data socket problem " + e.toString());
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_connectData, 5001);
};


// Submit a command to vah and register a callback for the reply
VAH.prototype.vahSubmit = function (cmd, callback, callbackPars) {
    // add the callback to the reply queue and issue the command; if there are multiple commands,
    // send all replies to the callback with a single call.
    // Also, if callback is null, the command is assumed not to return a reply.
    if (!Array.isArray(cmd))
        cmd = [cmd];
    if (callback)
        this.replyHandlerQueue.push({callback: callback, par: callbackPars});
    if (this.cmdSock) {
        for (const c of cmd) {
            if (c != 'list') console.log("VAH command: ", c);
            this.cmdSock.write(c + '\n');
        }
    } else {
        // console.log("VAH about to queue: " + cmd + "\n");
        for (var i in cmd)
            this.commandQueue.push(cmd + '\n');
    }
};


// Submit a start/stop command to vah. Uses VahSubmit to send the command but then remembers
// whether the port is on or off so that the rate check knows whether to expect data.
VAH.prototype.vahStartStop = function (startstop, devLabel, callback, callbackPars) {
    const cmd = startstop + " " + devLabel;
    this.vahSubmit(cmd, callback, callbackPars);
    // info from VAH comes back as 'pN', the 'p' stands for Plugin...
    if (startstop != 'start') {
        delete this.frames['p'+devLabel]; // remove plugin from list being monitored
    }
};


VAH.prototype.gotCmdReply = function (data) {
    // vamp-alsa-host replies are single JSON-formatted strings on a single line ending with '\n'
    // if multiple commands are submitted with a single call to vahSubmit,
    // their replies are returned in an array with a single call to the callback.
    // Otherwise, the reply is sent bare (i.e. not in an array of 1 element).

    this.replyBuf += data.toString();
    // console.log("VAH replied: " + data.toString());
    for(;;) {
        var eol = this.replyBuf.indexOf("\n");
        if (eol < 0) break;
        var replyString = this.replyBuf.substring(0, eol);
	    this.replyBuf = this.replyBuf.substring(eol + 1);

        if (replyString.length == 0)
            continue;

	    var reply = JSON.parse(replyString);

        if (reply.async) {
            // if async field is present, this is not a reply to a command
            console.log("VAH async: ", JSON.stringify(reply));
            this.matron.emit(reply.event, reply.devLabel, reply);
        } else {
            // deal with the new reply
            var handler = this.replyHandlerQueue.shift();

            if (!handler)
                continue;
            if (handler.callback)
                handler.callback(reply, handler.par);
        }
    }
};

VAH.prototype.vahAccept = function(pluginLabel) {
    // indicate that VAH should accept data from the specified plugin
    if (this.dataSock) {
        console.log("VAH asking to receive " + pluginLabel);
        this.dataSock.write("receive " + pluginLabel + "\n");
        this.frames[pluginLabel] = { at: Date.now(), frames: null, bad: 0 };
        if (!this.checkRateTimer) {
            // start monitoring sample rates
            // doing this here so we get a prompt response to the first list command
            this.checkRateTimer = setInterval(() => this.checkRates(), checkRatesInterval);
            this.checkRates(); // this may be too early, TBD...
        }
    }
};

VAH.prototype.gotData = function(data) {
    this.dataBuf += data.toString();
    const lines = this.dataBuf.split('\n');
    this.dataBuf = lines.pop();
    //for (const l of lines) console.log("vahData:", l)
    for (const l of lines) this.matron.emit("vahData", l);
};

VAH.prototype.quit = function() {
    this.quitting = true;
    this.child.kill("SIGKILL");
    };

VAH.prototype.getRawStream = function(devLabel, rate, doFM) {
    // return a readableStream which will produce raw output from the specified device, until the socket is closed
    var rawSock = Net.connect(this.sockPath, function(){});
    rawSock.stop = function() {rawSock.write("rawStreamOff " + devLabel + "\n"); rawSock.destroy();}

    rawSock.start = function() {rawSock.write("rawStream " + devLabel + " " + rate + " " + doFM + "\n")};
    return rawSock;
};

VAH.prototype.checkRates = function() {
    this.vahSubmit("list", reply => this.checkRatesReply(reply));
};

var logRateCnt = 0;

VAH.prototype.checkRatesReply = function(reply) {
    // NOTE: `p` in this function refers to a value like `p2` where the `p` really stands for
    // VAH Plugin, but `p` is also used as Port designator here. The use of the same letter is
    // actually a coincidence. It works, but not great.
    // check that all the plugins are producing data at the correct rate
    const now = Date.now()
    const minFct = 1 - boundsPCT/100
    const maxFct = 1 + boundsPCT/100
    // console.log("VAH rates: ", JSON.stringify(reply, null, 2));
    // console.log(`VAH frames: ${JSON.stringify(this.frames, null, 2)}`);
    for (const p in this.frames) {
        const fp = this.frames[p];
        if (p in reply) {
            var info = reply[p];
            if (info.type != 'PluginRunner') {
                console.log(`VAH checkRates: ${p} is not a plugin? ${JSON.stringify(info)}`);
                continue;
            }
            // console.log(`VAH info for ${p} at ${now} (dt=${now-fp.at}): ${JSON.stringify(info, null, 2)}`);
            this.matron.emit("vahFrames", p, now, info.totalFrames);
            // if fp.frames is null it just started and we don't have an initial frame count, so
            // get that (we used to set frames to 0 when starting but it takes a long time to actually
            // start and that caused low frame rates)
            if (fp.frames === null) {
                this.frames[p] = { ...fp, at: now, frames: info.totalFrames };
                continue;
            }
            // calculate the rate
            const dt = now - fp.at;
            if (dt < checkRatesInterval*0.9) continue; // too soon to calculate stable rate
            const df = info.totalFrames - fp.frames;
            const rate = df / dt * 1000;
            this.matron.emit("vahRate", p, now, rate);
            // OK or not?
            const ok = rate > info.rate*minFct && rate < info.rate*maxFct;
            if (!ok || logRateCnt++ < 100)
                console.log(`VAH rate for ${p}: nominal ${info.rate}, actual ${rate.toFixed(0)} frames/sec`);
            if (!ok) fp.bad++; else fp.bad = 0;
            if (fp.bad >= maxOutOfBounds) {
                const msg = `VAH rate for ${p} is out of range: nominal ${info.rate}, actual ${rate.toFixed(0)} frames/sec`
                console.log(msg);
                this.matron.emit("devStalled", p, msg);
                fp.bad = 0; // reset count so we don't continuously signal devStalled
            }
            // Update the current frame count for the next check
            this.frames[p] = { ...fp, at: now, frames: info.totalFrames };
        } else if (fp.frames > 0 || Date.now() - fp.at > checkRatesInterval*0.9) {
            // plugin has died
            console.log(`VAH plugin ${p} has died`);
            this.matron.emit("devStalled", p, `port ${p} is not producing data`);
        }
    }
};

module.exports = VAH;
