GPS=require('./gps.js')
ChildProcess  = require('child_process');
Net           = require('net');
assert = require('assert').strict;

let events = []
let matron = new Object()
matron.emit = function(ev, arg1, arg2) {
    events.push([ev, arg1, arg2])
}

let gps = new GPS.GPS(matron)
assert(gps.timeSource == 'unknown')
assert(gps.GPSstate == 'unknown')
assert(gps.RMSError == -1)
assert(gps.clockSyncDigits == -1)

// test an empty update
gps.updateState(0, `
`, '')
assert(gps.timeSource == 'unknown')
assert(gps.GPSstate == 'unknown')
assert(gps.RMSError == -1)
assert(gps.clockSyncDigits == -1)

// test a full update with NTP
gps.updateState(0, `
#,-,PPS,0,4,377,15,0.000000872,0.000001812,0.000000444
#,-,NMEA,0,4,377,14,0.006336060,0.006336060,0.010592043
^,-,162.159.200.123,3,10,377,450,-0.003702876,-0.003648454,0.029583102
^,*,162.159.200.1,3,10,377,627,-0.000652088,-0.000547641,0.027622031
^,-,62.228.228.9,2,10,357,1305,0.009152120,0.009259975,0.204187021
^,-,62.228.228.8,2,10,177,839,0.009754098,0.009907534,0.181059912
50505300,PPS,1,1637689935.658642346,-0.000000599,0.000000984,0.0003,8.582,0.008,0.071,0.000000001,0.000016526,16.0,Normal
`, '')
assert(gps.timeSource == 'NTP')
assert(gps.RMSError == 0.0003)
assert(gps.clockSyncDigits == 4)
assert(events.length == 1)
assert(events[0][0] == 'gpsSetClock')
events = []


// test a full update with gps-pps
gps.updateState(0, `
#,*,PPS,0,4,377,15,0.000000872,0.000001812,0.000000444
#,-,NMEA,0,4,377,14,0.006336060,0.006336060,0.010592043
^,-,162.159.200.123,3,10,377,450,-0.003702876,-0.003648454,0.029583102
^,-,162.159.200.1,3,10,377,627,-0.000652088,-0.000547641,0.027622031
^,-,62.228.228.9,2,10,357,1305,0.009152120,0.009259975,0.204187021
^,-,62.228.228.8,2,10,177,839,0.009754098,0.009907534,0.181059912
50505300,PPS,1,1637689935.658642346,-0.000000599,0.000000984,0.000001131,8.582,0.008,0.071,0.000000001,0.000016526,16.0,Normal
`, '')
assert(gps.timeSource == 'GPS-PPS')
assert(gps.RMSError == 0.000001131)
assert(gps.clockSyncDigits == 6)
assert(events.length == 1)
assert(events[0][0] == 'gpsSetClock')
console.log('done')
process.exit(0)
