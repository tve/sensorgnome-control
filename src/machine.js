// machine.js - keep track of machine-specific information:
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
const CP = require('child_process')
const log_key = 'software/log'  // flexdash key for text log of actions

exports.machineID = Fs.readFileSync("/etc/sensorgnome/id").toString().substring(0, 12)

var bootCountFile = "/etc/bootcount"
exports.bootCount = Fs.existsSync(bootCountFile) ?
    Number(Fs.readFileSync(bootCountFile).toString()) % 1000000 : 0

var versionFile = "/etc/sensorgnome/version";

exports.version = Fs.existsSync(versionFile) ? Fs.readFileSync(versionFile).toString() : "UNKNOWN"

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
      }
    } catch(err) {
      console.log("Error parsing df output:", err)
    }
  })
}

setTimeout(getDiskUsage, 10000)        // get disk usage info very soon
setInterval(getDiskUsage, 600*1000)  // every now and then get disk usage info

class Upgrader {
  constructor() {
    this.lock = null
  }

  reboot() {
    CP.execFile("/usr/sbin/shutdown", ["-r", "now"], (err, stdout, stderr) =>
        console.log(err || stderr || stdout)
    )
  }

  // exec the command and send the output to the dashboard log text widget
  // returns a promise that gets resolved with std if exit code is 0
  execAndLog(cmd, args, opts) {
    this.lock = Date.now()

    return new Promise((resolve, reject) => {
      const o = {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60*1000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        ...opts,
      }
      let proc = CP.spawn(cmd, args, o)
      let out="", err=""

      function updateLog() {
        if (err) FlexDash.set(log_key, "STDERR:\n" + err + "STDOUT:\n" + out)
        else FlexDash.set(log_key, out)
      }

      proc.stdout.on('data', (data) => { out += data; updateLog() })
      proc.stderr.on('data', (data) => { err += data; updateLog() })
      proc.on('close', code => {
        console.log("CMD: " + cmd + " --> " + code)
        this.lock = null
        if (code == 0) resolve(out)
        else reject(err)
      })
      proc.on('error', err => {
        console.log("CMD: " + cmd + " --> " + err)
        this.lock = null
        reject(err)
      })
    })
  }

  check() {
      this.execAndLog(
        "/bin/bash",
        ["-c", "/usr/bin/apt-get update; /usr/bin/apt list --upgradeable 2>/dev/null"],
      ).then(out => {
        let pkgs = []
        let m
        let re = RegExp('^([-a-zA-Z0-9_]+)/\\S+\\s+(\\S+)\\s+armhf', 'gm')
        while((m=re.exec(out)) !== null) {
          pkgs.push([ m[1], m[2] ])
        }
        console.log("Upgradable packages: " + pkgs.map(v=>v.join('/')).join(' '))
        const avail = pkgs.length > 0 ? pkgs.map(v=>v.join(' -- ')).join('\n') : "all up-to-date"
        FlexDash.set('software/available', avail)
      }).catch(err => console.log(err))
  }

  upgrade() {
    this.execAndLog("/usr/bin/apt-get", ["-y", "upgrade"])
    .then(out => {
      // let pkgs = []
      // let m
      // let re = RegExp('^([-a-zA-Z0-9_]+)/\\S+\\s+(\\S+)\\s+armhf', 'gm')
      // while((m=re.exec(out)) !== null) {
      //   pkgs.push([ m[1], m[2] ])
      // }
      // console.log("Upgradable packages: " + pkgs.map(v=>v.join('/')).join(' '))
      // FlexDash.set('software/available', pkgs.map(v=>v.join(' ')).join('\n'))
    }).catch(err => console.log(err))
}

}

exports.Upgrader = new Upgrader()
