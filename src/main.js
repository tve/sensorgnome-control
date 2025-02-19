// main.js - the main sensorgnome service which runs data acquisition

const DATADIR     = "/data/SGdata"                 // where data files are located
const CONFDIR     = "/etc/sensorgnome"             // where config files are located
const ACQUISITION = CONFDIR+"/acquisition.json"    // Receiver/sensor configuration
const PORTMAP     = CONFDIR+"/usb-port-map.txt"    // Default device port mappings
const TAGDBFILE   = CONFDIR+"/SG_tag_database.sqlite"
const BURSTDBFILE = CONFDIR+"/bursts.json"
const CELLCONFIG  = CONFDIR+"/cellular.json"
const FEEDCONFIG  = CONFDIR+"/feed.json"           // Serial output feed
const DEVROOT     = "/dev/sensorgnome"             // Dir where uDev rules add device files
const VARDIR      = "/var/lib/sensorgnome"         // where runtime state files are located
const DATAFILE    = VARDIR+"/datafiles.json"       // where database about data files is located
const STATEFILE   = VARDIR+"/motus_up.json"        // where motus upload state is stored

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

console.log(`\n===== sg-control starting at ${new Date().toISOString()} =====\n`)

// information about the system we're running on (machine ID and bootcount)
Machine       = require('./machine.js')
// load configuration
var Config    = require("./config.js")
//Deployment    = new Config.Deployment(DEPLOYMENT)
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
CellMan       = new (require('./cellular.js').CellMan)(TheMatron);

Schedule      = require('./schedule.js');
Sensor        = require('./sensor.js');
USBAudio      = require("./usbaudio.js");
RTLSDR        = require("./rtlsdr.js");
CornellTagXCVR= require("./cornelltagxcvr.js");

//WavMaker      = require('./wavmaker.js');

TagFinder     = null
function makeTagFinder() {
    TagFinder = new (require('./tagfinder.js').TagFinder)(
        TheMatron, "/usr/bin/find_tags_unifile", [ TAGDBFILE, CONFDIR+"/SG_tag_database.csv"],
        Acquisition.module_options.find_tags.params
    )
}
makeTagFinder()
TheMatron.on('lotekFreqChg', () => {
    console.log("Restarting tagFinder"); TagFinder.quit(); makeTagFinder(); TagFinder.start() })
PulseFilter   = new (require('./pulsefilter.js').PulseFilter) (TheMatron, BURSTDBFILE)

// Start the data file saving/writing/etc...
DataSaver     = new (require('./datasaver.js').DataSaver) (TheMatron, DATADIR)
DataFiles     = new (require('./datafiles.js').DataFiles) (TheMatron, DATADIR, DATAFILE)
SafeStream    = require('./safestream.js').SafeStream
MotusUp       = new (require('./motus_up.js').MotusUploader) (TheMatron, STATEFILE)
Feed          = new (require('./datafeed.js').Feed)(TheMatron, FEEDCONFIG)
// Create the two datafiles we write to for Lotek and CTT detections
// Rotate every hour and also if hitting 1MB in size
AllOut        = new SafeStream(TheMatron, "all", ".txt", 1000000, 3600, "parse")
LifetagOut    = new SafeStream(TheMatron, "ctt", ".txt", 1000000, 3600, "parse")

Upgrader      = new Machine.Upgrader()

//Uploader = new (require('./uploader.js').Uploader) (TheMatron);
//Relay = new (require('./relay.js').Relay) (TheMatron, 59000);

var clockNotSet = true;

// Propagate GPS fix info into data files
TheMatron.on("gotGPSFix", function(fix) {
    if (!fix.state?.includes('fix') || !fix.time) return
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
// TheMatron.on("vahData", (d) => { AllOut.write(d + '\n') })
// Propagate pulse filter output (as configured in burst finder) to data file
TheMatron.on("bfOut", (d) => { AllOut.write(d.text + '\n'); /*console.log("BF: " + d.text)*/ })
// Propagate vah setting commands into data file
TheMatron.on("setParam", (s) => {
    AllOut.write(["S", s.time, s.port, s.par, s.val, s.errCode, s.err].join(',') + "\n")
})
// Propagate time to all data files
TheMatron.on("gpsSetClock", (prec, elapsed) => {
    const line = ["C", Date.now() / 1000, prec, elapsed].join(',') + "\n"
    AllOut.write(line)
    LifetagOut.write(line)
})

// Start output feed
Feed.start()

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
PulseFilter.start()
TagFinder.start()

MotusUp.start()
WifiMan.start()
CellMan.start(CELLCONFIG)
