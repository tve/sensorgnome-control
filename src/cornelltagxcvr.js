// cornelltagxcvr - manage Cornell/CTT radio tag receivers

//   operate a Cornell (Gabrielson & Winkler) or CTT tag transceiver

//   This object represents a plugged-in CornellTagXCVR.  As soon as it
//   is created, it begins recording tag detections.  The device reports detections
//   via an FTDI FT232 USB serial adapter running at 115200 bps raw.  Tag
//   detections are printed as XXXXXXXX\r\n where X are hex digits.
//   The CTT LifeTag Motus Adapter reports detections as XXXXXXXX,RSSI\r\n.
//   The CTT LifeTag Motus Adapter V2 reports detections as XXXXXXXXCC,RSSI\r\n where CC is a checksum.
//   Later CTT radio firmware reports detections using a JSON format.

//   This module watches for such strings, and emits gotTag events of the form:
//       T[0-9]{1,2},<TS>,<ID>,<RSSI>,<version>\n
//   where the number after 'T' is the USB port #, <TS> is the ISO timestamp,
//   <ID> is the bare 8-hex digit tag ID, and <RSSI> is the raw RSSI value.
//   The <version> field is the CTT tag version: 1 has no checksum and 2 has a checksum.


// avoiding serialport module 'cause it requires native code install which is a PITA given
// the way we build packages (on x86) and deploy them on ARM
// const {SerialPort} = require('serialport')
// const {ReadlineParser} = require('@serialport/parser-readline')
const readline = require("readline")

class CornellTagXCVR {
  constructor(matron, dev) {
    this.matron = matron
    this.dev = dev
    this.sp = null // opened serial device
    this.fd = null // opened file descriptor
    this.rl = null // readline interface for readstream
    this.wd = null // watchdog interval timer
    this.gotVersion = 0 // timestamp of last version response

    this.matron.on("devRemoved", () => this.devRemoved())

    this.init()
  }

  devRemoved(dev) {
    if (dev.path != this.dev.path) return
    if (this.sp) {
      this.sp.close()
      this.sp = null
    }
    if (this.fd != null) {
      Fs.close(this.fd)
      this.fd = null
    }
    if (this.wd) {
      clearInterval(this.wd)
      this.wd = null
    }
  }

  init_sp() {
    this.sp = new SerialPort({ path: this.dev.path, baudRate: 115200 }) // baud rate irrelevant with USB
    this.sp.on("open", () => {
      // write a version command to see whether the radio supports that
      // apparently the firmware needs some time before it responds...
      setTimeout(() => this.askVersion(), 2000)
    })
    this.sp.on("close", () => {
      console.log("Closed " + this.dev.path)
    })
    this.sp.on("error", err => {
      console.log("Error opening/reading " + this.dev.path + ": " + err.message)
    })
    // hook up the parser to read incoming data
    const parser = new ReadlineParser({ delimiter: "\r\n" })
    parser.on("data", this.this_gotTag)
    this.sp.pipe(parser)
    console.log("Starting read stream at", this.dev.path)
  }

  init(no_write=false) {
    Fs.open(this.dev.path, "r+", (err, fd) => {
      if (err) {
        console.log("Error opening " + this.dev.path + ": " + err.message)
        return
      }
      this.fd = fd
      // create read stream
      const rs = Fs.createReadStream(null, { fd: fd })
      rs.on("error", err => console.log(`Error reading ${this.dev.path}: ${err.message}`))
      const rl = readline.createInterface({
        input: rs,
        terminal: false,
      })
      rl.on("line", l => this.gotTag(l))
      console.log("Starting read stream at", this.dev.path)
      // write a version command to see whether the radio supports that
      // apparently the firmware needs some time before it responds...
      if (!no_write) {
        setTimeout(() => this.askVersion(), 2000)
        setTimeout(() => this.checkVersion(), 6000)
      }
    })
  }

  // ask the dongle to tell us its version as a health-check
  askVersion() {
    if (this.sp) {
      this.sp.write("version\r\n", (err, n) => {
        if (err) console.log(`Error writing to ${this.dev.path}: ${err}`)
      })
    } else if (this.fd != null) {
      Fs.write(this.fd, "version\r\n", (err, n) => {
        if (err?.code == "EBADF") {
          console.log(`Cannot write to ${this.dev.path}, assuming old firmware`)
          // reopen the device and ensure we don't write again: it gets hung due to the write
          this.devRemoved(this.dev.path)
          this.init(true)
        } else if (err) {
          console.log(`Error writing to ${this.dev.path}: (${err.code}) ${err}`)
        }
      })
    }
  }

  // if we don't get the version after opening the device assume it's the old firmware and
  // reopen the device 'cause it gets stuck due to the attempted 'version\r\n' write
  checkVersion() {
    if (this.gotVersion == 0) {
      console.log(`No version response from ${this.dev.path}, assuming old firmware`)
      this.devRemoved(this.dev.path)
      this.init(true)
    }
  }

  jsonTag(json) {
    const port = this.dev.attr.port
    try {
      var now_secs = Date.now() / 1000
      var record = JSON.parse(json)
      if (record.firmware) {
        // response to a 'version' command with firmware version
        this.matron.emit("cttRadioVersion", { port, version: record.firmware })
        this.gotVersion = now_secs
        if (this.wd == null) {
          console.log(`CTT radio on port ${port} has firmware ${record.firmware}`)
          this.wd = setInterval(() => {
            if (now_secs - this.gotVersion > 60)
              console.log(`CTT radio on port ${port} is not respond`)
            this.askVersion()
          }, 60000)
        }
      } else if (record.key) {
        // response to a command (dunno what that corresponds to...)
        this.matron.emit("cttRadioResponse", { port, response: record })
      } else if (record.data?.tag) {
        // tag detection
        var tag = record.data.tag
        if (tag.error_bits == 0) {
          var lifetag_record = ["T" + port, now_secs, tag.id, record.rssi, "v" + tag.version].join(
            ","
          ) // build the values to generate a CSV row
          this.matron.emit("gotTag", lifetag_record + "\n")
          LifetagOut.write(lifetag_record + "\n")
        } else {
          console.log(`CTT tag with errors(?) on port ${port}: ${record}`)
        }
      } else {
        // unknown JSON record
        console.log(`Unknown CTT JSON record on port ${port}: ${record}`)
      }
    } catch (err) {
      console.log(`Error parsing CTT JSON on port ${port}: ${err.message}`)
    }
  }

  gotTag(record) {
    record = record.trim()
    if (record == "") return // happens due to CRLF
    console.log(`Got CTT line on p${this.dev.attr.port}: ${record}`)
    if (record.startsWith("{")) {
      // newer CTT receiver that emits a JSON record
      this.jsonTag(record)
    } else {
      // older CTT receiver that emits a bare tag ID
      // format: id,rssi
      var vals = record.split(",")
      var tag = vals.shift() // Tag ID should be the first field
      if (tag) {
        var now_secs = Date.now() / 1000
        var rssi = vals.shift() // RSSI should be the second field
        var lifetag_record = ["T" + this.dev.attr.port, now_secs, tag, rssi].join(",") // build the values to generate a CSV row
        this.matron.emit("gotTag", lifetag_record + "\n")
        // an event can be emitted here for vahdata if interested in streaming to 'all' files
        // this.matron.emit('vahData', lifetag_record+'\n')
        LifetagOut.write(lifetag_record + "\n")
      }
    }
  }
}

module.exports = CornellTagXCVR
