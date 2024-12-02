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
// (PITA is worth it 'cause just opening the device as a file isn't reliable)
const {SerialPort} = require('serialport')
// const {ReadlineParser} = require('@serialport/parser-readline')
const readline = require("readline")

let didEnum = false

let debugId = 1

class CornellTagXCVR {
  constructor(matron, dev) {
    if (!didEnum) this.enum()

    this.matron = matron
    this.dev = dev
    this.sp = null // opened serial device
    this.fd = null // opened file descriptor
    this.rl = null // readline interface for readstream
    this.wd = null // watchdog interval timer
    this.gotVersion = 0 // timestamp of last version response
    this.retries = 0 // number of retries opening the device

    this.matron.on("devRemoved", (dev) => this.devRemoved(dev))

    this.init_sp()
  }

  // enumerate serial ports for debugging purposes
  enum() {
    didEnum = true
    SerialPort.list().then((list) => {
      list.forEach((port) => {
        console.log("SerialPort: " + JSON.stringify(port) + "\n")
      })
    })
  }

  close() {
    if (this.sp) {
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
      console.log("Removed " + this.dev.path)
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

  devRemoved(dev) {
    if (!this.dev || dev.path != this.dev.path) return
    this.close()
    this.dev = null
  }

  init_sp(no_write=false) {
    if (!this.dev) return // device removed
    this.matron.emit("devState", this.dev.attr.port, "init")
    const path = this.dev.path
    const sp = new SerialPort({ path: path, baudRate: 115200 })
    const did = debugId++
    sp.on("open", () => {
      console.log(`Opened SerialPort #${did} ${path}`)
      // write a version command to see whether the radio supports that
      // apparently the firmware needs some time before it responds...
      if (no_write) {
        this.matron.emit("devState", this.dev.attr.port, "running") // we can't know...
      } else {
        setTimeout(() => this.askVersion(), 2000)
        setTimeout(() => this.checkVersion(), 6000)
      }
    })
    sp.on("close", () => {
      console.log(`SerialPort #${did} ${path} was closed`)
      if (this.dev && !this.dev.state.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", "port was closed");
    })
    sp.on("error", err => {
      console.log(`Error on SerialPort #${did} ${path}: ${err.message}\nStack: ${err.stack}`)
      if (this.dev && !this.dev.state.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", err.message);
      if (sp.isOpen) sp.close()
      if (this.retries++ < 3) {
        setTimeout(() => {
            this.init_sp()
        }, this.retries < 3 ? 10000 : 60000)
      }
      // note, could issue `usbreset ${this.dev.usbPath.replace(':','/')}` if retries >3
    })
    // hook up the parser to read incoming data
    if (0) {
      const parser = new ReadlineParser({ delimiter: "\r\n" })
      parser.on("data", this.this_gotTag)
      sp.pipe(parser)
    } else {
      this.buffer = ""
      sp.on("data", data => {
        //console.log(`CTT got: <${data.toString().trim()}>`)
        this.buffer += data.toString()
        while (true) {
          const i = this.buffer.indexOf("\r\n")
          if (i < 0) break
          const l = this.buffer.slice(0, i)
          this.buffer = this.buffer.slice(i+1)
          this.gotTag(l)
        }
      })
    }
    this.sp = sp
    console.log("Starting read stream using SerialPort at", path)
  }

  // Not used! (determined in constructor)
  init(no_write=false) {
    if (!this.dev) return // device removed
    this.matron.emit("devState", this.dev.attr.port, "init");
    Fs.open(this.dev.path, "r+", (err, fd) => {
      if (err) {
        console.log("Error opening " + this.dev.path + ": " + err.message)
        return
      }
      this.fd = fd
      // create read stream
      const rs = Fs.createReadStream(null, { fd: fd })
      rs.on("error", err => console.log(`Error reading ${this.dev.path}: ${err.message}`))
      rs.on("end", () => { console.log(`EOF reading ${this.dev.path}`); this.init_sp() })
      if (0) {
        const rl = readline.createInterface({
          input: rs,
          terminal: false,
        })
        rl.on("line", l => this.gotTag(l))
      } else {
        this.buffer = ""
        rs.on("data", data => {
          this.buffer += data.toString()
          console.log(`CTT got: <${data.toString()}>`)
          while (true) {
            const i = this.buffer.indexOf("\r\n")
            if (i < 0) break
            const l = this.buffer.slice(0, i)
            this.buffer = this.buffer.slice(i+1)
            this.gotTag(l)
          }
        })
      }
      console.log("Starting read stream using FSOpen at", this.dev.path)
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
        if (err) {
          console.log(`Error writing to ${this.dev?.path}: ${err} (retrying)`)
          // reopen device
          this.close()
          this.init_sp(true)
        }
      })
    } else if (this.fd != null) {
      // code section if not using SerialPort
      Fs.write(this.fd, "version\r\n", (err, n) => {
        if (err?.code == "EBADF") {
          console.log(`Cannot write to ${this.dev?.path}, assuming old firmware`)
          // reopen the device and ensure we don't write again: it gets hung due to the write
          this.close()
          this.init(true)
        } else if (err) {
          console.log(`Error writing to ${this.dev?.path}: (${err.code}) ${err}`)
        }
      })
    }
  }

  // if we don't get the version after opening the device assume it's the old firmware and
  // reopen the device 'cause it gets stuck due to the attempted 'version\r\n' write
  checkVersion() {
    if (this.gotVersion == 0) {
      console.log(`No version response from ${this.dev?.path}, assuming old firmware`)
      this.close()
      // give removal/close/... time to propagate before reopening
      setTimeout(() => {
        console.log("Reopening " + this.dev?.path)
        if (this.fd) {
          this.init(true)
        } else {
          this.init_sp(true)
        }
      }, 1000)
    }
  }

  jsonTag(json) {
    const port = this.dev.attr.port
    try {
      var now_secs = Date.now() / 1000
      var record = JSON.parse(json)
      if (record.firmware) {
        if (this.attr?.attr) this.attr.attr.type = "CTTv3"
        // response to a 'version' command with firmware version
        this.matron.emit("cttRadioVersion", { port, version: record.firmware })
        this.matron.emit("devState", this.dev.attr.port, "running");
        this.gotVersion = now_secs
        if (this.wd == null) {
          console.log(`CTT radio on port ${port} has firmware ${record.firmware}`)
          this.wd = setInterval(() => {
            if (now_secs - this.gotVersion > 60) {
              const msg = `CTT radio on port ${port} is not responding`
              console.log(msg)
              this.matron.emit("devState", this.dev.attr.port, "error", msg);
            }
            this.askVersion()
          }, 60000)
        }
      } else if (record.key) {
        // response to a command (dunno what that corresponds to...)
        this.matron.emit("cttRadioResponse", { port, response: record })
        this.matron.emit("devState", this.dev.attr.port, "running");
      } else if (record.data?.tag || record.data?.id) {
        // tag detection
        if (this.dev.state != "running")
          this.matron.emit("devState", this.dev.attr.port, "running");
        var tag = record.data?.tag || record.data
        var rssi = record.data?.rssi || record.meta?.rssi
        if (!('error_bits' in tag) || tag.error_bits == 0) {
          var lifetag_record = ["T" + port, now_secs, tag.id, rssi].join(
            ","
          ) // build the values to generate a CSV row
          this.matron.emit("gotTag", lifetag_record)
          LifetagOut.write(lifetag_record + "\n")
          console.log(`CTT json tag: ${lifetag_record}`)
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
    if (record.match(/[0-9a-fA-F]{10},/)) {
      //console.log(`Got CTT tag w/CRC on p${this.dev.attr.port}: ${record}`)
    }
    if (record.startsWith("{")) {
      // newer CTT receiver that emits a JSON record
      //console.log("JSON from CTT on p" + this.dev.attr.port)
      this.jsonTag(record)
    } else if (record.match(/[0-9a-fA-F]{8,10},/)) {
      // older CTT receiver that emits a bare tag ID
      // format: id,rssi
      var vals = record.split(",")
      var tag = vals.shift() // Tag ID should be the first field
      if (tag) {
        if (this.dev.state != "running")
          this.matron.emit("devState", this.dev.attr.port, "running");
        var now_secs = Date.now() / 1000
        var rssi = vals.shift() // RSSI should be the second field
        var lifetag_record = ["T" + this.dev.attr.port, now_secs, tag, rssi].join(",") // build the values to generate a CSV row
        this.matron.emit("gotTag", lifetag_record)
        LifetagOut.write(lifetag_record + "\n")
        console.log(`CTT tag: ${lifetag_record}`)
      }
    } else {
      console.log(`Unknown CTT record on p${this.dev.attr.port}: ${record}`)
    }
  }
}

module.exports = CornellTagXCVR
