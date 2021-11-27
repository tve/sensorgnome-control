// chrony - monitoring of time synchronization status using chronyc
// Copyright 2021 Thorsten von Eicken

const time_stamp_codes = ["P", "Z", "Y", "X", "W", "V", "U", "T"];
// "P" clock not synchronized, "Z" = 1 second, "Y" = 0.1 second, "X" = 0.01 second
// "W" = 0.001 second, "V" = 0.0001 second, "U" = 0.00001 second, "T" = 0.000001 second

const period = 20*1000 // monitoring interval in milliseconds

class Chrony {

    constructor(matron) {
        this.matron = matron
        this.rms_error = null // RMS error of system time in seconds
        this.time_source = null // unknown, NTP, GPS-no-PPS, GPS-PPS
        this.clock_sync_digits = -1; // number of fractional digits in seconds precision of clock sync
    }
    
    timeStampCode () {
        return time_stamp_codes[1 + this.clock_sync_digits];
    }
    
    update(code, stdout) {
        if (! code) {
            let src = stdout.match(/^.,\*,.*/m) // current time source
            let digits = -1
            let time_source = null
            let rms_error = null
            if (src) {
                // figure out time source
                let fields = src[0].split(",")
                //console.log("Chronyc source:", fields.join(','))
                if (fields[2] == "PPS") {
                    time_source = "GPS-PPS"
                } else if (fields[2] == "NMEA") {
                    time_source = "GPS-no-PPS/RTC"
                } else if (fields[2].match(/^[.0-9]+$/)) {
                    time_source = "NTP"
                } else {
                    time_source = "unknown"
                }
                // figure out number of significant digits
                let last_line = stdout.match(/[^\n]+\n$/)
                if (last_line) {
                    //console.log("Chronyc tracking:", last_line[0])
                    let trk = last_line[0].split(','); // get output of tracking command
                    if (trk.length > 7 && trk[6].length > 0) {
                        rms_error = parseFloat(trk[6])
                        digits = -Math.round(Math.log10(rms_error))
                        if (digits < 0) digits = -1
                        if (digits > 6) digits = 6 // got no code past 6, and let's not fool ourselves
                    }
                }
            }
            // send event if the number of clock digits has changed
            if (digits != this.clock_sync_digits) {
                this.clock_sync_digits = digits
                this.matron.emit("gpsSetClock", this.clock_sync_digits, 0.0) // how to get time advance?
                    //Number(stdout.toString().split(/,/)[2].split(/: /)[1]))
            }
            // send event if source info has changed
            if (time_source != this.time_source || rms_error != this.rms_error) {
                this.time_source = time_source
                this.rms_error = rms_error
                this.matron.emit("chrony", { time_source, rms_error })
            }
        }
    }

    // start monitoring chrony by calling chronyc periodically
    start() {
        let self = this
        function run() {
            ChildProcess.execFile(
                "/usr/bin/chronyc", ["-cm", "sources", "tracking"],
                (code, stdout, stderr) => {
                    self.update(code, stdout)
                    setTimeout(run, period)
                });
        }
        run()
    }
}

exports.Chrony = Chrony
