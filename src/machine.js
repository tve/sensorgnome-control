// machine.js - keep track of machine-specific information and upgrade software packages
//
// - machineID: unique 12 character code for this machine
//   (i.e. differs from one unit to another)
//   read from /etc/beaglebone_id (only first 12 chars are used)
//
// - bootCount: number of times this sytem (SDcard) has been booted
//   eread from /etc/bootcount; taken modulo 1e6
//
// - also gets general information about filesystem usage (df)

const Fs = require('fs')
const Fsp = require('fs/promises')
const CP = require('child_process')

const log_key = 'software/log'  // flexdash key for text log of actions
const upgrade_log = '/var/log/upgrade.log'
const upgrader_dir = '/opt/sensorgnome/upgrader'
const check_re = RegExp('^([-a-zA-Z0-9_]+)/\\S+\\s+(\\S+)\\s+(armhf|all)\\s+.upgradable from: ([-a-z0-9_.:+]+)', 'gm')

exports.machineID = Fs.readFileSync("/etc/sensorgnome/id").toString().trim()
exports.machineKey = Fs.readFileSync("/etc/sensorgnome/key").toString().trim()

let mt = exports.machineID.replace(/.*-[0-9A-Z]{4}([0-9A-Z]{4})[0-9A-Z]{4}/, "$1")
if (mt.startsWith('RPI')) mt = `Raspberry Pi ${mt.slice(3)}`
else if (mt.startsWith('BBB')) mt = `BeagleBone ${mt.slice(3)}`
else if (mt.startsWith('RPZ')) mt = `Raspberry Pi Zero ${mt.slice(3)}`
else if (mt.startsWith('RPS')) mt = `SensorStation V${mt.slice(3)}`
else if (mt.startsWith('RPC')) mt = `Compute Module ${mt.slice(3)}`
exports.machineType = mt

const pwdfile = Fs.readFileSync("/etc/passwd").toString()
exports.username = (/^([^:]+):[^:]*:1000:/m).exec(pwdfile)?.[1] || "gnome"

var bootCountFile = "/etc/sensorgnome/bootcount"
exports.bootCount = Fs.existsSync(bootCountFile) ?
    Number(Fs.readFileSync(bootCountFile).toString()) % 1000000 : 99990

var versionFile = "/etc/sensorgnome/version";

exports.version = Fs.existsSync(versionFile) ? Fs.readFileSync(versionFile).toString() : "UNKNOWN"
exports.sdDataSize = '?'

function getDiskUsage() {
  CP.exec("findmnt --df --json --real", (err, stdout) => {
    if (err) {
      console.log("Error in df:", err)
      return
    }
    try {
      var df = JSON.parse(stdout).filesystems.filter(fs => fs.fstype.match(/(ext)|(fat)/))
      // {"source":"/dev/mmcblk0p2", "fstype":"ext4", "size":"2.8G", "used":"2.2G",
      //  "avail":"488.7M", "use%":"77%", "target":"/"},
      TheMatron.emit("df", df)
      const df_data = df.filter(d=>d.target=="/data")
      if (df_data) {
        TheMatron.emit("sdcardUse", parseInt(df_data[0]['use%'], 10))
        TheMatron.emit("sdDataSize", df_data[0]['size'])
        exports.sdDataSize = df_data[0]['size']
      }
    } catch(err) {
      console.log("Error parsing df output:", err)
    }
  })
}

setTimeout(getDiskUsage, 10000)      // get disk usage info very soon
setInterval(getDiskUsage, 600*1000)  // every now and then get disk usage info

// get the amount of memory on this machine
exports.memorySize = '?'
Fs.readFileSync("/proc/meminfo").toString().split("\n").forEach(line => {
  if (line.startsWith("MemTotal:")) {
    let sz = parseInt(line.split(/\s+/)[1], 10) // kB
    sz = (sz/1024/1024).toFixed(1) + " GB"
    exports.memorySize = sz
  }
})

class Upgrader {
  constructor() {
    this.lock = null
    this.watchLog()
    this.out = "" // output of current/last command
  }

  start() {
  }

  restart() {
    CP.execFile("/usr/bin/systemctl", ["restart", "sg-control"], (err, stdout, stderr) =>
      console.log(err || stderr || stdout)
    )
  }

  reboot() {
    CP.execFile("/usr/sbin/shutdown", ["-r", "now"], (err, stdout, stderr) =>
      console.log(err || stderr || stdout)
    )
  }

  shutdown() {
    CP.execFile("/usr/sbin/shutdown", ["-h", "now"], (err, stdout, stderr) =>
      console.log(err || stderr || stdout)
    )
  }

  // exec returns a promise!
  exec(cmd, args, opts) {
    const uplog = Fs.openSync(upgrade_log, "a")
    const o = {
      stdio: ["ignore", uplog, uplog],
      timeout: 60 * 1000,
      ...opts,
    }
    this.out = ""
    return new Promise((resolve, reject) => {
      let proc = CP.spawn(cmd, args, o)
      // signal when process completes
      proc.on("close", code => {
        console.log("CMD: " + cmd + " --> " + code)
        this.lock = null
        if (code == 0) setTimeout(() => resolve(this.out), 200)
        else reject(code)
      })
      proc.on("error", err => {
        console.log("CMD: " + cmd + " --> " + err)
        this.lock = null
        reject(err)
      })
    })
  }

  // watchLog watches the upgrade log file and pushes updates to FlexDash.
  // it only pushes the last 100 lines so scrolling doesn't become too crazy
  async watchLog() {
    const fd = await Fsp.open(upgrade_log, "a+")
    let pos = 0
    let txt = []
    let self = this

    async function read() {
      try {
        while (true) {
          let { bytesRead, buffer } = await fd.read({ position: pos, length: 24 })
          //console.log("watchLog @"+pos+" -> "+bytesRead)
          if (bytesRead == 0) break
          buffer = buffer.toString("utf8", 0, bytesRead)
          pos += bytesRead
          self.out += buffer
          buffer = txt.pop() + buffer
          let n = buffer.split("\n")
          txt = txt.concat(n)
          if (txt.length > 100) txt = txt.slice(txt.length - 100)
          FlexDash.set(log_key, txt.join("\n"))
        }
      } catch (err) {
        console.log("Error reading upgrade log: " + err)
        FlexDash.set(log_key, "Error reading upgrade log: " + err)
      }
    }

    setTimeout(() => {
      fd.write("\n")
    }, 100) // trigger watcher
    try {
      const watcher = Fsp.watch(upgrade_log, { persistent: false })
      for await (const ev of watcher) {
        await read()
      }
    } catch (err) {
      if (err.name === "AbortError") return
    }
  }

  check() {
    FlexDash.set("software/available", "checking...")
    FlexDash.set("software/enable", false)
    this.exec(upgrader_dir + "/check.sh")
      .then(out => {
        let pkgs = []
        console.log("Looking at:\n" + out)
        let m
        while ((m = check_re.exec(out)) !== null) {
          pkgs.push([m[1], m[2], m[3]])
        }
        console.log("Upgradable packages: " + pkgs.map(v => v.join("/")).join(" "))
        const sgPkgs = pkgs
          .filter(v => v[0].match(/^(sensorgnome|sg-)/))
          .map(v => v[0] + ": " + v[1] + " (" + v[2] + ")")
        const osPkgs = pkgs
          .filter(v => !v[0].match(/^(sensorgnome|sg-)/))
          .map(v => v[0] + ": " + v[1] + " (" + v[2] + ")")
        const sgText = sgPkgs.length > 0 ?
          "Available Sensorgnome packages:\n" + sgPkgs.join("\n") :
          "All Sensorgnome packages are up-to-date"
        const osText = osPkgs.length > 0 ?
          "Available OS packages:\n" + osPkgs.join("\n") :
          "All OS packages are up-to-date"
        const avail =
          "Checked at " + new Date().toISOString() + "\n\n" + sgText + "\n\n" + osText
        FlexDash.set("software/available", avail)
        FlexDash.set("software/enable", true)
        FlexDash.set("software/enable_upgrade", pkgs.length > 0)
      })
      .catch(err => {
        console.log(err)
        FlexDash.set("software/enable", true)
      })
  }

  // perform an upgrade, runs apt-get upgrade in a script that deals with systemd
  // what==system -> apt upgrade, what==sensorgnome -> apt upgrade sensorgnome
  upgrade(what) {
    const opt = what == "system" ? ["-s"] : [what]
    FlexDash.set("software/enable", false)
    this.exec(upgrader_dir + "/upgrade.sh", opt, { detached: true, timeout: 180 * 1000 })
      .then(out => {
        // let pkgs = []
        // let m
        // let re = RegExp('^([-a-zA-Z0-9_]+)/\\S+\\s+(\\S+)\\s+armhf', 'gm')
        // while((m=re.exec(out)) !== null) {
        //   pkgs.push([ m[1], m[2] ])
        // }
        // console.log("Upgradable packages: " + pkgs.map(v=>v.join('/')).join(' '))
        // FlexDash.set('software/available', pkgs.map(v=>v.join(' ')).join('\n'))
        FlexDash.set("software/enable", true)
      })
      .catch(err => console.log(err))
      FlexDash.set("software/enable", true)
    }
}

exports.Upgrader = Upgrader
