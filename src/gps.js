// GPS querying
// Copyright ©2021 Thorsten von Eicken

// Connect to gpsd and ask for fixes.
// The coordinates are written to data files.

class GPS {
    constructor(matron) {
        this.matron = matron
        this.replyBuf = ""
        this.gpsdCon = null
        this.conTimeOut = null
        this.retryTime = 5000

        // self-bound closures for callbacks
        this.this_gpsdReply = this.gpsdReply.bind(this) 
        this.this_conError = this.conError.bind(this)
        this.this_connect = this.connect.bind(this)
        this.this_getFix = this.getFix.bind(this)
    }

    gpsdReply(r) {
        // gpsd with the Gtop GPS used in the Adafruit HAT is a mess. When the GPS looses a fix 
        // gpsd continues to pretend there's a 3d fix 'cause the GPS' RTC sends the time... We have
        // to look at the number of satellites used in the fix to see whether it's really a fix or not.
        try {
            this.retryTime = 5000
            this.replyBuf += r.toString()
            for(;;) {
                var eol = this.replyBuf.indexOf("\n")
                if (eol < 0)
                    break
                var reply = JSON.parse(this.replyBuf.substring(0, eol))
                this.replyBuf = this.replyBuf.substring(eol + 1)
                if (reply["class"] == "POLL") {
                    var mode = 0 // GPS mode: unknown/no-fix/2d-fix/3d-fix
                    var sats = 0 // number of satellites used in fix
                    var fix = reply.tpv[0] || {}
                    if (fix.class == "TPV")  mode = fix.mode
                    var sky = reply.sky[0] || {}
                    if (sky.class == "SKY" && "satellites" in sky) {
                        var sats = 0
                        for (const s of sky.satellites) {
                            if (s.used) sats++
                        }
                    }
                    if (mode >= 2 && sats < 2) mode = 1 // fix is a lie
                    fix.state = ["no-dev", "no-sat", "2D-fix", "3D-fix"][mode]
                    if (fix.time) fix.time = (new Date(fix.time)).getTime()/1000
                    this.matron.emit("gotGPSFix", fix)
                }
            }
        } catch (e) {
            console.error("GPSD: parse error", e)
        }
    }

    connect() {
        this.conTimeOut = null
        this.sentWatch = false
        this.gpsdCon = Net.connect(2947, () => this.getFix() )
        this.gpsdCon.on("data", this.this_gpsdReply)
        this.gpsdCon.on("error", this.this_conError)
        this.gpsdCon.on("end", this.this_conError)
    }

    conError(e) {
        console.log("GPSD connect error", e.message)
        this.gpsdCon.destroy()
        this.gpsdCon = null
        this.matron.emit("gotGPSFix", { state: "no-dev"})
        this.conTimeOut = setTimeout(this.this_connect, this.retryTime)
        this.retryTime = Math.min(600000, this.retryTime * 2)
    }

    getFix() {
        if (this.gpsdCon) {
            if (! this.sentWatch) {
                this.gpsdCon.write('?WATCH={"enable":true};\n')
                this.sentWatch = true
            }
            this.gpsdCon.write("?POLL;\n")
        } else if (! this.conTimeOut) {
            this.conTimeOut = setTimeout(this.this_connect, 5000)
        }
    }

    start(fixInterval) {
        if (!this.gpsdCon) this.connect()

        if (this.interval)
            clearInterval(this.interval)
        this.interval = setInterval(this.this_getFix, fixInterval * 1000, this)
    }
}

module.exports = GPS
