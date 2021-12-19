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

exports.machineID = Fs.readFileSync("/etc/sensorgnome_id").toString().substring(0, 12)

var bootCountFile = "/etc/bootcount"
exports.bootCount = Fs.existsSync(bootCountFile) ?
    Number(Fs.readFileSync(bootCountFile).toString()) % 1000000 : 0

var versionFile = "/etc/sensorgnome_version";

exports.version = Fs.existsSync(versionFile) ? Fs.readFileSync(versionFile).toString() : "UNKNOWN"

function getDiskUsage() {
  ChildProcess.exec("findmnt --df --json --real", (err, stdout) => {
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
