/*
  main.js - the main sensorgnome service which launches data acquisition according to
  a stored program.  This service is restarted every 60 seconds (as set in its systemd
  file) if it stops or fails.
*/

// process.on("uncaughtException", function(err) {
//      console.log('Caught exception: ' + err);
// });

var doneQuit = false;

function quitProcess () {
    if (doneQuit)
        return;
    doneQuit = true;
    console.log("Exiting from main.js!\n");
    TheMatron.emit("quit");
    setTimeout(function() {console.log("Bye"); process.exit(0)}, 3000);
};

process.on("SIGTERM", quitProcess);
process.on("SIGQUIT", quitProcess);
process.on("exit", quitProcess);

Fs            = require('fs');
Path          = require('path');
Util          = require('util');
ChildProcess  = require('child_process');
Net           = require('net');
Events        = require('events');
Zlib          = require('zlib');

// information about the unit we're running on
// (machine ID and bootcount)

Machine = require('./machine.js');

// Matron is a global object on which all SensorGnome event listeners
// are registered, and from which all SensorGnome events are emitted.

Matron = require('./matron.js');
TheMatron = new Matron.Matron();

// Load singleton objects
GPS           = new (require('./gps.js'))(TheMatron);
Chrony        = new (require('./chrony.js'))(TheMatron);
HubMan        = new (require('./hubman.js'))(TheMatron, "/dev/sensorgnome");
VAH           = new (require('./vah.js'))(TheMatron, "/usr/bin/vamp-alsa-host", "VAH.sock");
WebServer     = new (require('./webserver.js'))(TheMatron);
FlexDash      = new (require('./flexdash.js'))(TheMatron);
Dashboard     = new (require('./dashboard.js'))(TheMatron);

Schedule      = require('./schedule.js');
Sensor        = require('./sensor.js');
USBAudio      = require("./usbaudio.js");
RTLSDR        = require("./rtlsdr.js");
CornellTagXCVR= require("./cornelltagxcvr.js");

//WavMaker      = require('./wavmaker.js');

// Figure out the location of the deployment.txt file
Deployment = new (require("./deployment.js").Deployment)(
    [
        "/data/config/deployment.txt",  // new preferred location
    ]);

// replace "-" with "_" in deployment short label, so filenames
// use "-" only for delimiting fields

Deployment.shortLabel = Deployment.shortLabel.replace(/-/g,"_");

TagFinder = new (require('./tagfinder.js').TagFinder)(
    TheMatron,
    "/usr/bin/find_tags_unifile",
    [
        "/data/config/SG_tag_database.sqlite",  // new preferred location
        "/data/config/SG_tag_database.csv"],
    Deployment.module_options.find_tags.params
);

DataSaver     = new (require('./datasaver.js').DataSaver) (TheMatron);
DataFiles     = new (require('./datafiles.js'))(TheMatron);

SafeStream    = require('./safestream.js').SafeStream;

AllOut = new SafeStream(TheMatron, "all", ".txt", 1000000, 3600, "parse");

LifetagOut = new SafeStream(TheMatron, "ctt", ".txt", 1000000, 3600, "parse");

Uploader = new (require('./uploader.js').Uploader) (TheMatron);

Relay = new (require('./relay.js').Relay) (TheMatron, 59000);


var clockNotSet = true;

function do_nothing(err, stdout, stderr) {
};

TheMatron.on("gotGPSFix", function(fix) {
    let line = "G," + fix.time + "," + fix.lat + "," + fix.lon + "," + fix.alt + "\n"
    AllOut.write(line)
    LifetagOut.write(line)
    //ugly hack to set date from gps if gps has fix but system clock not set
    if (clockNotSet && (new Date()).getFullYear() < 2013) {
        console.log("Trying to set time to " + fix.time + "\n");
        ChildProcess.exec("date --utc -s @" + fix.time, do_nothing);
        clockNotSet = false;
    }
});

TheMatron.on("vahData", function(d) {
    AllOut.write(d);
});

TheMatron.on("setParam", function(s) {
    AllOut.write("S," + s.time + "," + s.port + "," + s.par + "," + s.val + "," + s.errCode + "," + s.err + "\n");
});

TheMatron.on("gpsSetClock", function(prec, elapsed) {
    let line = "C," + Date.now() / 1000 + "," + prec + "," + elapsed + "\n"
    AllOut.write(line);
    LifetagOut.write(line);
});

// Start the uploader

Uploader.start();

setTimeout(()=>DataFiles.start(), 2000); // wait for stuff to settle a bit before scanning media

// start the GPS reader

GPS.start(Deployment.acquire.gps.secondsBetweenFixes);
Chrony.start();

// Now that all listeners for devAdded events have been registered, we
// can start HubMan.

HubMan.start();

// Start the webserver

WebServer.start(FlexDash);
FlexDash.start(WebServer);
Dashboard.start();

// Start the tagFinder

TagFinder.start();

// Start the relay, which can resend messages from the matron to an arbitrary port
