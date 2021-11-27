/*
  machine.js - keep track of machine-specific information:
  
  - machineID: unique 12 character code for this machine
    (i.e. differs from one unit to another)
    read from /etc/beaglebone_id (only first 12 chars are used)

  - bootCount: 6 digit integer (as a string) which increases by 1 at
    each boot.  Can help to distinguish among time periods in case of
    GPS failure.  read from /etc/bootcount; taken modulo 1e6, and left
    padded with '0's to 6 digits

*/

var machineID = Fs.readFileSync("/etc/sensorgnome_id").toString().substring(0, 12);
var bootCountFile = "/etc/bootcount"
var bootCount = (Fs.existsSync(bootCountFile) ?
                      Number(Fs.readFileSync(bootCountFile).toString()) % (1000000)
                      :
                      0);
//bootCount = "00000".substring(0, 6 - bootCount.length) + bootCount;

var versionFile = "/etc/sensorgnome_version";
var version;

if (Fs.existsSync(versionFile))
    version = Fs.readFileSync(versionFile).toString();
else
    version = "UNKNOWN";

exports.machineID = machineID;
exports.bootCount = bootCount;
exports.version = version;


