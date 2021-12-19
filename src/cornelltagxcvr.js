/*

  operate a Cornell (Gabrielson & Winkler) tag transceiver, in
  receive-only mode; also works for a CTT LifeTag Motus Adapter

  This object represents a plugged-in CornellTagXCVR.  As soon as it
  is created, it begins recording tag detections.  The device reports detections
  via an FTDI FT232 USB serial adapter running at 115200 bps raw.  Tag
  detections are printed as XXXXXXXX\r\n where X are hex digits.
  The CTT LifeTag Motus Adapter reports detections as XXXXXXXX,RSSI\r\n.
  The CTT LifeTag Motus Adapter V2 reports detections as XXXXXXXXCC,RSSI\r\n where CC is a checksum.

  This module watches for such strings, and emits gotTag events of the form:

      T[0-9]{1,2},<TS>,<ID>,<RSSI>\n

  where the number after 'T' is the USB port #, <TS> is the ISO timestamp,
  <ID> is the bare 8-hex digit tag ID, and <RSSI> is the raw RSSI value.

*/

const readline = require('readline');

CornellTagXCVR = function(matron, dev) {

    this.matron = matron;
    this.dev = dev;
    this.rs = null;   // readable stream to serial device 
    this.rl = null; // readline interface for readstream
    this.rate = 115200; // assumed fixed serial rate (bits per second)

    // callback closures
    this.this_devRemoved             = this.devRemoved.bind(this);
    this.this_gotTag                 = this.gotTag.bind(this);

    this.matron.on("devRemoved", this.this_devRemoved);

    this.init();
};


CornellTagXCVR.prototype.devRemoved = function(dev) {
    if (dev.path != this.dev.path)
        return;
    if (this.rs) {
        this.rs.close();
        this.rs = null;
    }
};

CornellTagXCVR.prototype.init = function() {
    // open the device fd

    try {
        this.rs = Fs.createReadStream(this.dev.path);
        this.rl = readline.createInterface({
            input: this.rs,
            terminal: false 
        });
        this.rl.on("line", this.this_gotTag);
        //console.log('Starting read stream at', this.dev.path);
    } catch (e) {
        // not sure what to do here
        console.log("Failed to open CornellTagXCVR at " + this.dev.path + "\n");
        console.log(e);
    }
};

CornellTagXCVR.prototype.gotTag = function(record) {
    //console.log("Got CTT line: " + record)
    var vals = record.split(',')
    var tag = vals.shift(); // Tag ID should be the first record
    // emit all detections at once
    if (tag) {
        var now_secs = Date.now() / 1000;
        var rssi = vals.shift(); // RSSI should be the second record
        var lifetag_record = ['T'+this.dev.attr.port, now_secs, tag, rssi].join(',')  // build the values to generate a CSV row
        this.matron.emit('gotTag', lifetag_record+'\n');
        // an event can be emitted here for vahdata if interested in streaming to 'all' files
        // this.matron.emit('vahData', lifetag_record+'\n');
        LifetagOut.write(lifetag_record+'\n');
    }
};

exports.CornellTagXCVR = CornellTagXCVR;
