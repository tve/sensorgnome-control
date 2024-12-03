// feed - data feed with all data written to files for output to serial port or similar
// Copyright ©2024 Thorsten von Eicken

const {SerialPort} = require('serialport')
const fs = require('node:fs')

class Feed {
  constructor(matron, configfile) {
    this.matron = matron
    this.configfile = configfile
  }

  readFeedConfig() {
    try {
      const json = fs.readFileSync(this.configfile)
      const data = JSON.parse(json)
      if (data && typeof data == 'object') return data
      console.log("Cannot parse feed config from", this.configfile)
    } catch(e) {
      if (e.code != 'ENOENT') console.log("Error reading", this.configfile, ":", e)
    }
  }
  
  start() {
    // read the config
    const feedconfig = this.readFeedConfig()
    if (!feedconfig) return
    if (!feedconfig.path) return
    const path = feedconfig.path
    const speed = feedconfig.speed || 115200

    const isSerial = path.startsWith('/dev/')
    const sp = isSerial ? new SerialPort({ path, baudRate: speed })
                        : fs.createWriteStream(path, {flags: 'a'})
    sp.on("open", () => {
      console.log(`Opened output feed ${path}`)
      // subscribe to events we want to output
      // input received from vamp-alsa-host, i.e. Lotek pulses
      this.matron.on("vahData", (d) => { sp?.write(d + '\n') })
      // tags detected (CTT tags and tagfinder)
      this.matron.on("gotTag", (d) => {
        if (d[0] >= '0' && d[0] <= '9') d = 'L'+d // lotek tag detection
        sp?.write(d + '\n')
      })
      // vah setting commands
      this.matron.on("setParam", (s) => {
          sp?.write(["S", s.time, s.port, s.par, s.val, s.errCode, s.err].join(',') + "\n")
      })
      // time changes
      this.matron.on("gpsSetClock", (prec, elapsed) => {
        sp?.write(["C", Date.now() / 1000, prec, elapsed].join(',') + "\n")
      })
      // GPS fix changes
      this.matron.on("gotGPSFix", (fix) => {
        if (!fix.state?.includes('fix') || !fix.time) return
        sp?.write("G," + fix.time + "," + fix.lat + "," + fix.lon + "," + fix.alt + "\n")
      })
    })
    sp.on("close", () => {
      console.log(`Output feed ${path} was closed`)
      sp = null
    })
    sp.on("error", err => {
      console.log(`Error on output feed ${path}: ${err.message}\nStack: ${err.stack}`)
      if (sp.isOpen) sp.close()
      sp = null
    })
    sp.on("data", data => { /*drop*/ })
    this.sp = sp
    console.log("Starting output feed", path)
  }

}

module.exports = { Feed }
