// cellular -- monitor and config cellular (LTE) modem

var Fs = require("fs")
var Fsp = require("fs").promises

const MMCLI = "/usr/bin/mmcli"
const CHECK_MODEM = "/opt/sensorgnome/cellular/check-modem.sh"

class CellConfig {
  constructor(path) {
    this.path = path
    // config values
    this.data = { apn: "", "ip-type": "ipv4v6", "allow-roaming": "yes", priority: "low"}
    //
    try {
      let text = Fs.readFileSync(path).toString()
      var d = JSON.parse(text)
      for (let j in d) this.data[j] = d[j]
    } catch (e) {
      console.log("Error loading cellular config:", e.message)
      for (let j in d) this.data[j] = ""
    }
  }

  // update config object
  update(new_values) {
    let changed = false
    for (let k in new_values) {
      if (k in this.data) {
        changed = changed || this.data[k] != new_values[k]
        this.data[k] = new_values[k]
        console.log("Cellular: updating", k, "to", new_values[k])
      }
    }
    // save to file
    if (changed) {
      ;(async () => {
        try {
          console.log("Saving ", this.path)
          await Fsp.writeFile(this.path + "~", JSON.stringify(this.data, null, 2))
          try {
            await Fsp.rename(this.path, this.path + ".bak")
          } catch (e) {
            if (e.code != "ENOENT") throw e
          }
          await Fsp.rename(this.path + "~", this.path)
        } catch (e) {
          console.log("ERROR: failed to save cellular config: ", e)
        }
      })().then(() => {})
    }
  }
}

// ===== cellular status and control
class CellMan {
  constructor(matron) {
    this.matron = matron
    this.cellStatusTimer = null
    this.cell_state = ""
    this.config = null
    this.setInter
  }

  start(configPath) {
    this.config = new CellConfig(configPath)
    this.matron.emit("netCellConfig", this.config.data)
    this.matron.on("netDefaultRoute", () => this.getCellStatusSoon(400))
    this.getCellStatusSoon(400)
  }

  setCellConfig(config) {
    if (typeof config == 'object' && typeof config.apn == 'string') {
      this.config.update({
        apn: config.apn,
        'ip-type': config["ip-type"] || "ipv4v6",
        'allow-roaming': config["allow-roaming"] || "yes",
      })
      this.matron.emit("netCellConfig", this.config.data)
      ChildProcess.execFile(CHECK_MODEM, ["-r"], (code, stdout, stderr) => {
        console.log(`Check-modem script code=${code} stdout=${stdout} stderr=${stderr}`)
      })
      this.getCellStatusSoon(2000)
    }
  }

  getCellPriority() {
    let metric = undefined
    ChildProcess.execFile("/usr/bin/ip", ["route"], (code, stdout, stderr) => {
      console.log(`ip route code=${code} stderr=${stderr}`)
      for (const line of stdout.split('\n')) {
        const mm = line.match(/^default .*dev (wwan[0-9]|usb[0-9]).* metric ([0-9]*)/)
        if (mm && mm[2]) { metric = parseInt(mm[2]); break }
      }
    })
    if (!metric) {
      try {
        let text = Fs.readFileSync("/etc/dhcpcd.conf").toString()
        const mm = text.match(/^metric ([0-9]*)/m)
        if (mm && mm[1]) metric = parseInt(mm[1])
      } catch (e) {
        console.log("Error reading dhcpcd config: " + e.toString())
      }
    }
    return metric < 1000 ? "high" : "low"
  }

  setCellPriority(priority) {
    if (!["low","high"].includes(priority)) return
    if (priority == this.config.priority) return // no change
    this.config.update({priority})
    const metric = priority == "high" ? 500 : 10000
    ChildProcess.execFile("/usr/bin/sed",
      ["-i", "-e", `s/^metric .*/metric ${metric}/`, "/etc/dhcpcd.conf"],
      (code, stdout, stderr) => {
        console.log(`Change cell metric code=${code} stdout=${stdout} stderr=${stderr}`)
        ChildProcess.execFile("/usr/bin/systemctl", ["restart", "dhcpcd"], (code, stdout, stderr) => {
          console.log(`Restart dhcpcd code=${code} stdout=${stdout} stderr=${stderr}`)
        })
      }
    )
  }

  getCellStatusSoon(ms) {
    if (!this.cellStatusTimer) this.cellStatusTimer = setTimeout(() => this.getCellStatus(), ms)
  }

  getCellStatus() {
    let m, info, reason
    this.cellStatusTimer = null
    this.execMMCli(null, ["-L"], true)
      .then(modems => {
        if (modems && "modem-list" in modems && modems["modem-list"].length > 0) {
          m = modems["modem-list"][0].replace(/.*\//, "")
          return this.execMMCli(m, [], true)
        } else return "no-modem"
      })
      .then(data => {
        if (typeof data == "string") {
          this.cell_state = data
          this.matron.emit("netCellState", data)
          this.matron.emit("netCellReason", "")
          this.matron.emit("netCellInfo", {})
          this.getCellStatusSoon(30000)
          return
        }
        // parse state
        const modem = data["modem"]
        const old_state = this.cell_state
        this.cell_state = modem.generic.state
        reason = modem.generic["state-failed-reason"]
        if (reason == "--") reason = "timeout?"
        this.matron.emit("netCellState", this.cell_state)
        this.matron.emit("netCellReason", reason)
        // see whether a connectivity check is in order
        if (old_state != this.cell_state) this.getCellStatusSoon()
        if (!["connected"].includes(this.cell_state)) {
          this.getCellStatusSoon(20000)
        } else {
          this.getCellStatusSoon(300000)
        }
        // pull out some info to display in props table
        info = {}
        info["power state"] = modem?.generic?.["power-state"]
        info["operator name"] = modem?.["3gpp"]?.["operator-name"]
        info["registration state"] = modem?.["3gpp"]?.["registration-state"]
        info["packet service"] = modem?.["3gpp"]?.["packet-service-state"]
        info["capabilities"] = modem?.generic?.["current-capabilities"].join(" ")
        info["model"] = modem?.generic?.model
        info["imei"] = modem?.["3gpp"]?.["imei"]
        info["number"] = modem?.generic?.["own-numbers"]?.join(" ")
        // see what to query next
        const bearer = modem?.generic?.bearers?.length > 0 && modem?.generic?.bearers[0]
        if (bearer) return this.execMMCli(m, ["-b", bearer.replace(/.*\//, "")], true)
        if (!["no-sim", "disabled", "failed"].includes(this.cell_state))
          return this.execMMCli(m, ["--3gpp-scan"], false) // true)
        return {}
      })
      .then(data => {
        if (typeof data != "object" || data == {}) {
        } else if ("bearer" in data) {
          const bearer = data?.["bearer"]
          // Misc
          info["bearer conn"] = bearer?.status?.["connected"]
          info["bearer error"] = bearer?.status?.["connection-error"]?.["message"]
          if (info["bearer conn"] != "yes" && info["bearer error"])
            this.matron.emit("netCellReason", info["bearer error"])
          info.APN = bearer?.properties?.["apn"]
          if (reason = "" && info.APN == "") {
            reason = "APN not set"
            this.matron.emit("netCellReason", reason)
          }
          info["ip type"] = bearer?.properties?.["ip-type"]
          info.roaming = bearer?.properties?.["roaming"]
          info["ip timeout"] = bearer?.status?.["ip-timeout"]
          // IPv4
          if (bearer?.["ipv4-config"])
            info["ipv4 addr"] =
              bearer?.["ipv4-config"]?.address + "/" + bearer?.["ipv4-config"]?.prefix
          else info["ipv4 addr"] = ""
          info["ipv4 gw"] = bearer?.["ipv4-config"]?.gateway
          // IPv6
          if (bearer?.["ipv6-config"])
            info["ipv6 addr"] =
              bearer?.["ipv6-config"]?.address + "/" + bearer?.["ipv6-config"]?.prefix
          else info["ipv6 addr"] = ""
          info["ipv6 gw"] = bearer?.["ipv6-config"]?.gateway
          if (reason == "") {
            if (info["ipv4 addr"] == "" || info["ipv4 addr"].startsWith('169.254')) {
              this.matron.emit("netCellState", "no IP addr")
            } else {
              this.matron.emit("netCellReason", info["ipv4 addr"].replace(/\/.*/, ''))
            }
          }
        } else if (data.modem?.["3gpp"]?.["scan-networks"]) {
          const nets = data.modem?.["3gpp"]?.["scan-networks"]
          //console.log("nets:", nets)
          info["scan"] = nets.length + " networks"
          for (let i = 0; i < nets.length && i < 10; i++) {
            const op = nets[i]["operator-name"] + " (" + nets[i]["operator-code"] + ")"
            const tech = nets[i]["access-technologies"]
            const avail = nets[i]["availability"]
            // const op = nets[i].match(/operator-name: *([^,]*)/)?.[1]
            // const tech = nets[i].match(/access-technologies: *([^,]*)/)?.[1]
            // const avail = nets[i].match(/availability: *([^,]*)/)?.[1]
            if (op) info[op] = tech + ", " + avail
          }
          if (reason == "") {
            reason = "Searching for carrier"
            this.matron.emit("netCellReason", reason)
          }
        }
        console.log("Cell state:", this.cell_state)
        if (["registered","connected"].includes(this.cell_state)) {
          return this.execMMCli(m, ["--signal-get"], true)
        }
        this.matron.emit("netCellInfo", info)
      })
      .then(data => {
        if (typeof data != "object" || data == {}) {
        } else if ("modem" in data && "signal" in data.modem) {
          const sig = data.modem.signal
          for (const rat in sig) {
            if (rat == "threshold") continue
            if ((sig[rat].rssi && sig[rat].rssi != '--') ||
                (sig[rat].rsrp && sig[rat].rsrp != '--')) {
              info["signal"] = { rat, ...sig[rat] }
              break
            }
          }
        this.matron.emit("netCellInfo", info)
      }
      })
      .catch(err => {
        console.log("getCellStatus:", err.message.trim())
        if (info != {}) this.matron.emit("netCellInfo", info)
      })
  }

  async getCellDebug() {
    try {
      const res1 = await this.execFile(MMCLI, ["-m", "a"])
      const bearer = res1.match(/([^ \n]*Bearer[^ \n]*)/)?.[1]
      const sim = res1.match(/([^ \n]*\/SIM\/[^ \n]*)/)?.[1]
      console.log("SIM:", sim)
      console.log("Bearer:", bearer)
      const res2 = sim ? await this.execFile(MMCLI, ["-m", "a", "-i", sim]) : "no sim"
      const res3 = bearer ? await this.execFile(MMCLI, ["-m", "a", "-b", bearer]) : "no bearer"
      return res1 + "\n\nSIM:\n" + res2 + "\n\nBearer:\n" + res3
    } catch (err) {
      return "Error getting cellular dump: " + err.stack
    }
  }

  async getCellScan() {
    try {
      const res1 = await this.execFile(MMCLI, ["-m", "a", "--3gpp-scan"])
      return res1
    } catch (err) {
      return "Error performing cellular scan: " + err.stack
    }
  }
  async execMMCli(modem, args, nolog = false) {
    const a = ["-J", ...args]
    if (modem != null) a.unshift("-m", modem)
    const res = await this.execFile(MMCLI, a)
    if (!nolog) console.log(`ModemManager [${a.join(" ")}]: ${res.replace(/\n/g, "\\n")}`)
    const data = JSON.parse(res)
    return data
  }

  execFile(cmd, args) {
    return new Promise((resolve, reject) => {
      ChildProcess.execFile(cmd, args, (code, stdout, stderr) => {
        //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
        if (code || stderr) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || code}`))
        else resolve(stdout.trim())
      })
    })
  }
}

module.exports = { CellMan }
