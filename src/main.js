// main.js - the main sensorgnome service which runs data acquisition

const DATADIR     = "/data/SGdata"                 // where data files are located
const CONFDIR     = "/etc/sensorgnome"             // where config files are located
const DATAFILE    = CONFDIR+"/datafiles.json"      // where database about data files is located
const DEPLOYMENT  = CONFDIR+"/deployment.json"     // SensorGnome deployment info
const ACQUISITION = CONFDIR+"/acquisition.txt"     // Receiver/sensor configuration
const PORTMAP     = CONFDIR+"/usb-port-map.txt"    // Default device port mappings
const DEVROOT     = "/dev/sensorgnome"             // Dir where uDev rules add device files

// process.on("uncaughtException", function(err) {
//      console.log('Caught exception: ' + err);
// });

var doneQuit = false;

function quitProcess () {
    if (doneQuit)
        return
    doneQuit = true
    console.log("Exiting from main.js!\n")
    TheMatron.emit("quit")
    setTimeout(function() {console.log("Bye"); process.exit(1)}, 3000)
}

process.on("SIGTERM", quitProcess)
process.on("SIGQUIT", quitProcess)
process.on("exit", quitProcess)

Fs            = require('fs');
Path          = require('path');
Util          = require('util');
ChildProcess  = require('child_process');
Net           = require('net');
Events        = require('events');
Zlib          = require('zlib');

// information about the system we're running on (machine ID and bootcount)
Machine       = require('./machine.js')
// load configuration
var Config    = require("./config.js")
Deployment    = new Config.Deployment(DEPLOYMENT)
Acquisition   = new Config.Acquisition(ACQUISITION)

// Matron is a global object on which all SensorGnome event listeners
// are registered, and from which all SensorGnome events are emitted.
Matron        = require('./matron.js');
TheMatron     = new Matron.Matron();

// Load singleton objects
GPS           = new (require('./gps.js'))(TheMatron);
Chrony        = new (require('./chrony.js'))(TheMatron);
HubMan        = new (require('./hubman.js'))(TheMatron, DEVROOT, PORTMAP);
VAH           = new (require('./vah.js'))(TheMatron, "/usr/bin/vamp-alsa-host", "VAH.sock");
//WebServer     = new (require('./webserver.js'))(TheMatron);
FlexDash      = new (require('./flexdash.js'))(TheMatron);
Dashboard     = new (require('./dashboard.js'))(TheMatron);
WifiMan       = new (require('./wifiman.js').WifiMan)(TheMatron);

Schedule      = require('./schedule.js');
Sensor        = require('./sensor.js');
USBAudio      = require("./usbaudio.js");
RTLSDR        = require("./rtlsdr.js");
CornellTagXCVR= require("./cornelltagxcvr.js");

//WavMaker      = require('./wavmaker.js');

TagFinder = new (require('./tagfinder.js').TagFinder)(
    TheMatron,
    "/usr/bin/find_tags_unifile",
    [ CONFDIR+"/SG_tag_database.sqlite", CONFDIR+"/SG_tag_database.csv"],
    Deployment.module_options.find_tags.params
)

// Start the data file saving/writing/etc...
DataSaver     = new (require('./datasaver.js').DataSaver) (TheMatron, DATADIR)
DataFiles     = new (require('./datafiles.js').DataFiles) (TheMatron, DATADIR, DATAFILE)
SafeStream    = require('./safestream.js').SafeStream
MotusUp       = new (require('./motus_up.js').MotusUploader) (TheMatron)
// Create the two datafiles we write to for Lotek and CTT detections
// Rotate every hour and also if hitting 1MB in size
AllOut        = new SafeStream(TheMatron, "all", ".txt", 1000000, 3600, "parse") // 1MB max filesize
LifetagOut    = new SafeStream(TheMatron, "ctt", ".txt", 1000000, 3600, "parse")

//Uploader = new (require('./uploader.js').Uploader) (TheMatron);
//Relay = new (require('./relay.js').Relay) (TheMatron, 59000);

var clockNotSet = true;

// Propagate GPS fix info into data files
TheMatron.on("gotGPSFix", function(fix) {
    let line = "G," + fix.time + "," + fix.lat + "," + fix.lon + "," + fix.alt + "\n"
    AllOut.write(line)
    LifetagOut.write(line)
    //ugly hack to set date from gps if gps has fix but system clock not set
    if (clockNotSet && (new Date()).getFullYear() < 2013) {
        console.log("Trying to set time to " + fix.time + "\n")
        ChildProcess.exec("date --utc -s @" + fix.time, ()=>{})
        clockNotSet = false
    }
})

// Propagate input received from vamp-alsa-host, i.e. Lotek pulses, to data file
TheMatron.on("vahData", (d) => { AllOut.write(d) })
// Propagate vah setting commands into data file
TheMatron.on("setParam", (s) => {
    AllOut.write(["S", s.time, s.port, s.par, s.val, s.errCode, s.err].join(',') + "\n")
})
// Propagate gps fixes to all data files
TheMatron.on("gpsSetClock", (prec, elapsed) => {
    const line = ["C", Date.now() / 1000, prec, elapsed].join(',') + "\n"
    AllOut.write(line)
    LifetagOut.write(line)
})

//Uploader.start();

// After initial flurry settles, read in info about existing data files
setTimeout(()=>{ DataFiles.start().then(()=>{}) }, 2000)

// start the GPS reader
GPS.start(Acquisition.gps.secondsBetweenFixes)
Chrony.start()

// Now that all listeners for devAdded events have been registered, we can start HubMan.
HubMan.start()

// Start the web dashboard
//WebServer.start(FlexDash)
FlexDash.start()
Dashboard.start()

// Start the tagFinder
TagFinder.start()

MotusUp.start()
WifiMan.start()
