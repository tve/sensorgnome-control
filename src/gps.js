/*

  GPS handling 

  Connect to gpsd and ask for fixes.  We connect to chrony and wait
  asynchronously for finer and finer GPS clock settings, emitting a
  "gpsSetClock" event with the digits of precision and the approximate
  amount by which time was advanced by the fix, in seconds.

*/

function GPS (matron) {
    this.matron = matron;
    this.lastFix = null;
    this.replyBuf = "";
    this.gpsdCon = null;
    this.conTimeOut = null;
    this.RMSError = -1; // RMS error of system time in seconds
    this.GPSstate = "unknown"; // unknown, no-gps-dev, no-sat, time-no-fix, fix
    this.timeSource = "unknown"; // unknown, NTP, GPS-no-PPS, GPS-PPS
    this.clockSyncDigits = -1; // number of fractional digits in seconds precision of clock sync (only valid when GPSHasSetClock is true)

    // timestamp codes:
    this.timeStampCodes = ["P", "Z", "Y", "X", "W", "V", "U", "T"];
    // "P" clock not set by GPS
    // "Z" = 1 second
    // "Y" = 0.1 second
    // "X" = 0.01 second
    // "W" = 0.001 second
    // "V" = 0.0001 second
    // "U" = 0.00001 second
    // "T" = 0.000001 second

    // deprecated
    //this.GPSHasSetClock = false;

    // self-bound closures for callbacks
    this.this_updateState = this.updateState.bind(this);
    this.this_gpsdReply = this.gpsdReply.bind(this); 
    this.this_conError = this.conError.bind(this);
    this.this_connect = this.connect.bind(this);
    this.this_getFix = this.getFix.bind(this);
    this.this_getTimeState = this.getTimeState.bind(this);
    // spawn a process to wait for a clock adjustment to within 1 second of GPS time
    this.getTimeState();
    // connect to gpsd
    this.connect();
};

GPS.prototype.getTimeState = function() {
    this.chronyChild = ChildProcess.execFile(
        "/usr/bin/chronyc",
        ["-cm", "sources", "tracking"],
        this.this_updateState);
};

GPS.prototype.timeStampCode = function() {
    return this.timeStampCodes[1 + this.clockSyncDigits];
};

GPS.prototype.gpsdReply = function(r) {
    // gpsd with the Gtop GPS used in the Adafruit HAT is a mess. When the GPS looses a fix 
    // gpsd continues to pretend there's a 3d fix 'cause the GPS' RTC sends the time... We have
    // to look at the number of satellites used in the fix to see whether it's really a fix or not.
    try {
        this.replyBuf += r.toString();
        for(;;) {
            var eol = this.replyBuf.indexOf("\n");
            if (eol < 0)
                break;
            var reply = JSON.parse(this.replyBuf.substring(0, eol));
            this.replyBuf = this.replyBuf.substring(eol + 1);
            if (reply["class"] == "POLL") {
                var mode = 0; // GPS mode: unknown/no-fix/2d-fix/3d-fix
                var sats = 0; // number of satellites used in fix
                var newfix = false;
                var fix = reply.tpv[0];
                if (fix && fix["class"]=="TPV") {
                    newfix = true;
                    mode = fix.mode;
                }
                var sky = reply.sky[0]
                if (sky && sky["class"]=="SKY") {
                    var sats = 0;
                    for (const s of sky["satellites"]) {
                        if (s.used) sats++;
                    }
                }
                if (newfix && mode >= 2 && sats >= 2) {
                    // gpsd claims a 2d or 3d fix and gps uses at least 2 satellites
                    this.lastFix = fix;
                    this.GPSstate = ["no-dev", "no-sat", "2D-fix", "3D-fix"][fix.mode];
                    this.matron.emit("gotGPSFix", {
                        lat:fix.lat, lon:fix.lon, alt:fix.alt,
                        time:(new Date(fix.time)).getTime()/1000
                    });
                } else {
                    this.GPSstate = "no-sat"
                }
                //console.log("GPSstate:", this.GPSstate);
            }
        }
    } catch (e) {
        /**/
    }
};

GPS.prototype.connect = function() {
    this.conTimeOut = null;
    this.sentWatch = false;
    this.gpsdCon = Net.connect(2947, function() {});
    this.gpsdCon.on("data", this.this_gpsdReply);
    this.gpsdCon.on("error", this.this_conError);
    this.gpsdCon.on("end", this.this_conError);
};

GPS.prototype.conError = function(e) {
    this.gpsdCon.destroy();
    this.gpsdCon = null;
    this.conTimeOut = setTimeout(this.this_connect, 5000);
};

GPS.prototype.getFix = function() {
    if (this.gpsdCon) {
        if (! this.sentWatch) {
            this.gpsdCon.write('?WATCH={"enable":true};\n');
            this.sentWatch = true;
        }
        this.gpsdCon.write("?POLL;\n");
    } else if (! this.conTimeOut) {
        this.conTimeOut = setTimeout(this.this_connect, 5000);
    }
};

GPS.prototype.start = function(fixInterval) {
    if (this.interval)
        clearInterval(this.interval);
    this.interval = setInterval(this.this_getFix, fixInterval * 1000, this);
};

GPS.prototype.updateState = function(code, stdout, stderr) {
    if (! code) {
        this.chronyChild = null
        let src = stdout.match(/^.,\*,.*/m) // current time source
        let digits = this.clockSyncDigits
        if (src) {
            // figure out time source
            let fields = src[0].split(",")
            //console.log("Chronyc source:", fields.join(','));
            if (fields[2] == "PPS") {
                this.timeSource = "GPS-PPS"
            } else if (fields[2] == "NMEA") {
                this.timeSource = "GPS-no-PPS/RTC"
            } else if (fields[2].match(/^[.0-9]+$/)) {
                this.timeSource = "NTP"
            } else {
                this.timeSource = "unknown"
            }
            // figure out number of significant digits
            let last_line = stdout.match(/[^\n]+\n$/)
            if (last_line) {
                //console.log("Chronyc tracking:", last_line[0])
                let trk = last_line[0].split(','); // get output of tracking command
                if (trk.length > 7 && trk[6].length > 0) {
                    this.RMSError = parseFloat(trk[6])
                    digits = -Math.round(Math.log10(this.RMSError))
                    if (digits < 0) digits = -1
                    if (digits > 6) digits = 6 // got no code past 6, and let's not fool ourselves
                } else {
                    this.RMSError = -1
                    digits = -1
                }
            }
        } else {
            this.RMSError = -1
            this.timeSource = "unknown"
            digits = -1
        }
        // send event if the number of clock digits has changed
        if (digits != this.clockSyncDigits) {
            this.clockSyncDigits = digits
            this.matron.emit("gpsSetClock", this.clockSyncDigits, 0.0) // how to get time advance?
                //Number(stdout.toString().split(/,/)[2].split(/: /)[1]))
        }
    }
        
    setTimeout(this.this_getTimeState, 21*1000)
};

exports.GPS = GPS
