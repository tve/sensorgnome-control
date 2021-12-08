/*
  machine.js - keep track of machine-specific information:
  
  - machineID: unique 12 character code for this machine
    (i.e. differs from one unit to another)
    read from /etc/beaglebone_id (only first 12 chars are used)

  - bootCount: 6 digit integer (as a string) which increases by 1 at
    each boot.  Can help to distinguish among time periods in case of
    GPS failure.  read from /etc/bootcount; taken modulo 1e6, and left
    padded with '0's to 6 digits

  - also gets general information about filesystem usage (df)
*/

exports.machineID = Fs.readFileSync("/etc/sensorgnome_id").toString().substring(0, 12)

var bootCountFile = "/etc/bootcount"
exports.bootCount = Fs.existsSync(bootCountFile) ?
    Number(Fs.readFileSync(bootCountFile).toString()) % (1000000) : 0

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
      // {"source":"/dev/mmcblk0p2", "fstype":"ext4", "size":"2.8G", "used":"2.2G", "avail":"488.7M", "use%":"77%", "target":"/"},

      TheMatron.emit("df", df)
    } catch(err) {
      console.log("Error parsing df output:", err)
    }
  })
}

setTimeout(getDiskUsage, 10000)
setInterval(getDiskUsage, 10*60*1000)
