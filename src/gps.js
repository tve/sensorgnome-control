/*

  GPS handling 

  Connect to gpsd and ask for fixes.  We connect to chrony and wait
  asynchronously for finer and finer GPS clock settings, emitting a
  "gpsSetClock" event with the digits of precision and the approximate
  amount by which time was advanced by the fix, in seconds.

*/

class GPS {
    constructor(matron) {
        this.matron = matron;
        this.lastFix = null;
        this.replyBuf = "";
        this.gpsdCon = null;
        this.conTimeOut = null;

        // self-bound closures for callbacks
        this.this_gpsdReply = this.gpsdReply.bind(this); 
        this.this_conError = this.conError.bind(this);
        this.this_connect = this.connect.bind(this);
        this.this_getFix = this.getFix.bind(this);
        // connect to gpsd
        this.connect();
    }

    gpsdReply(r) {
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
                        fix.state = ["no-dev", "no-sat", "2D-fix", "3D-fix"][fix.mode];
                        fix.time = (new Date(fix.time)).getTime()/1000;
                        this.lastFix = fix;
                        this.matron.emit("gotGPSFix", fix);
                    } else if (this.lastFix) {
                        this.matron.emit("gotGPSFix", { state: "no-sat" });
                        this.lastFix = null
                    }
                }
            }
        } catch (e) {
            /**/
        }
    }

    connect() {
        this.conTimeOut = null;
        this.sentWatch = false;
        this.gpsdCon = Net.connect(2947, function() {});
        this.gpsdCon.on("data", this.this_gpsdReply);
        this.gpsdCon.on("error", this.this_conError);
        this.gpsdCon.on("end", this.this_conError);
    }

    conError(e) {
        this.gpsdCon.destroy();
        this.gpsdCon = null;
        this.conTimeOut = setTimeout(this.this_connect, 5000);
    }

    getFix() {
        if (this.gpsdCon) {
            if (! this.sentWatch) {
                this.gpsdCon.write('?WATCH={"enable":true};\n');
                this.sentWatch = true;
            }
            this.gpsdCon.write("?POLL;\n");
        } else if (! this.conTimeOut) {
            this.conTimeOut = setTimeout(this.this_connect, 5000);
        }
    }

    start(fixInterval) {
        if (this.interval)
            clearInterval(this.interval);
        this.interval = setInterval(this.this_getFix, fixInterval * 1000, this);
    }
}

module.exports = GPS
