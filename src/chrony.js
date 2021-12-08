// chrony - monitoring of time synchronization status using chronyc
// Copyright ©2021 Thorsten von Eicken

// Info about tracking clock accuracy
// ----------------------------------
// The original gps code used gps sync info to report how many sub-second digits of the
// time were accurate. This was encoded in the filenames of data files as char after
// the fractional seconds: "Z" = 1 second, "Y" = 0.1 second, ..., "T" = 0.000001 second.
// The motivation seems to have been to enable triangulation by time-of-arrival, but this
// has never been put into practice.
// THere were multiple issues with the original approach:
// - data timestamps use the system clock, which is not the same as the gps time, so
//   focusing on gps precision is of limited use
// - the accuracy was only tracked in increasing precision, i.e., the number of digits
//   could not go down, which doesn't match reality (satellites move, cloud cover, electrical
//   storms, other interference, etc)
// - networked sensorgnomes use NTP (instead of or in addition to gps)
// Instead, this module now reports the precision that chrony reports, which is what actually
// matters. There is one piece of information that is difficult to get, which is when the
// clock is stepped. That's particularly useful when the clock starts unset at boot time and
// then gets set by synchronization: the delta of the step allows data collected preior to the
// step to be reprocessed and corrected.
// There are two ways to detect clock steps. One uses a linux kernel timer with a special flag
// that causes the timer to be canceled when the clock is stepped. The other is to use
// process.hrtime, which is monotonic and not affected by real-time clock steps to detect
// clock steps. The latter is used here because it's simpler.

const time_stamp_codes = ["P", "Z", "Y", "X", "W", "V", "U", "T"];
// "P" clock not synchronized, "Z" = 1 second, "Y" = 0.1 second, "X" = 0.01 second
// "W" = 0.001 second, "V" = 0.0001 second, "U" = 0.00001 second, "T" = 0.000001 second

const period = 20*1000 // monitoring interval in milliseconds
const emit_period = 600*1000 // emit time this often regardless

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

    // ticker monitors process.hrtime and Date.now, i.e., a monotonic non-adjusted clock vs.
    // time-of-day clock adjusted by chrony. If the two clocks differ from one measurement to
    // another then the time-of-day clock has been stepped and we record this to enable
    // post-processing of timestamps.
    // On clock step a gpsSetClock event is issued
    ticker() {
        let hrtime = process.hrtime.bigint()/1000000n
        let now = BigInt(Date.now())
        const abs = (x) => (x < 0n ? -x : x)
        const ds = 20n // smallest delta we consider to be a step (in millisecs)
        let last_emit = 0n
        setInterval(() => {
            // bracket Date.now() between two calls to hrtime() so we can ensure all three calls
            // are executed pretty much in sequence
            let hrt1, hrt2, now1
            for (let i=0; i<5; i++) {
                hrt1 = process.hrtime.bigint() // nanoseconds
                now1 = BigInt(Date.now()) // milliseconds
                hrt2 = process.hrtime.bigint()
                hrt1 /= 1000000n // convert to milliseconds
                hrt2 /= 1000000n // convert to milliseconds
                if (hrt2-hrt1 < ds/4n) break // typ. 0ms or 1ms
            }
            // deltas
            let d1 = hrt1 - hrtime
            let d2 = hrt2 - hrtime
            let dn = now1 - now
            // check if clock was stepped
            let s1 = abs(d1-dn), s2 = abs(d2-dn)
            if (s1 > ds && s2 > ds) {
                // step detected
                let step = s1 < s2 ? dn - d1 : dn - d2
                console.log(`chrony: clock step of ${step}ms detected (+/-${hrt1-hrt1}ms)`)
                this.matron.emit("gpsSetClock", this.clock_sync_digits, step)
                last_emit = hrt2
                this.update()
            } else if (hrt2 - last_emit > emit_period) {
                // emit time every emit_period
                this.matron.emit("gpsSetClock", this.clock_sync_digits, 0)
                last_emit = hrt2
            }
            // re-init
            hrtime = hrt2
            now = now1
        }, 1000)
    }
    
    // update queries chrony to determine the source of clock sync and its precision
    // if the precision changes then a gpsSetClock event is issued
    update() {
        ChildProcess.execFile(
            "/usr/bin/chronyc", ["-cm", "sources", "tracking"],
            (code, stdout, stderr) => {
                if (code) return
                // locate the source chrony is tracking
                let src = stdout.match(/^.,\*,.*/m) // current time source
                let digits = -1
                let time_source = "none"
                let max_error = null
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
                        time_source = "none"
                    }
                    // figure out number of significant digits
                    let last_line = stdout.match(/[^\n]+\n$/)
                    if (last_line) {
                        // https://www.mail-archive.com/chrony-users@chrony.tuxfamily.org/msg01196.html
                        //console.log("Chronyc tracking:", last_line[0])
                        let trk = last_line[0].split(','); // get output of tracking command
                        if (trk.length > 11) {
                            const system_offset = Math.abs(parseFloat(trk[4])) // offset of system clock to NTP/GPS time
                            const root_delay = parseFloat(trk[10]) // NTP root delay
                            const root_dispersion = parseFloat(trk[11]) // NTP root dispersion
                            max_error = system_offset + root_delay/2 + root_dispersion
                            digits = -Math.round(Math.log10(max_error))
                            if (digits < 0) digits = -1
                            if (digits > 6) digits = 6 // got no code past 6, and let's not fool ourselves
                        }
                    }
                }
                // send event if the number of clock digits has changed
                if (digits != this.clock_sync_digits) {
                    this.clock_sync_digits = digits
                    console.log(`chrony: clock sync precision changed to ${digits} digits`)
                    this.matron.emit("gpsSetClock", this.clock_sync_digits, 0.0)
                }
                // send event if source info has changed
                let max_error_p2 = max_error > 0 ? max_error.toPrecision(2) : Number.NaN
                if (time_source != this.time_source || max_error_p2 != this.max_error) {
                    this.time_source = time_source
                    this.max_error = max_error_p2
                    console.log(`chrony: time source is ${time_source}, error < ${max_error}`)
                    this.matron.emit("chrony", { time_source, max_error })
                }
            }
        )
    }

    // start monitoring chrony by calling chronyc periodically
    start() {
        this.update()
        setInterval(() => this.update(), period)
        this.ticker()
    }
}

module.exports = Chrony
