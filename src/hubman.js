/*

  USB Hub manager

  Handle devices as they appear or disappear from a specified directory by emitting events.
  Anyone interested in the devices can register a listener on the device manager for relevant events.

  Devices have names like "funcubePro.port=3.alsaDev=2.usbPath=1:22" where "." separates the
  device type and attributes settings so that in this example:
    - the device type is "funcubePro"
    - the usb port is 3 (* see note below)
    - the ALSA device number is 2
    - the USB path is 1:22 (bus 1, device #22) this is as required by libusb

  This hub manager ignores any devices without the "port=X" attribute.

  Note that these device names are symlinks in special directory created by udev rules
  e.g. /dev/sensorgnome.  That directory is meant to include only devices which we recognize
  and make visible to end users.

  Other objects can force the device manager to emit an event by calling its "emit" method.

  Events emitted
  ==============

  Events have a name, and the object sent with them has associated properties.

  "devAdded":  a device has been plugged into a USB port, arg is:
   { path: full path to device symlink
     attr: list of attribute settings.  Following the example above,
           this would be {type:"funcubePro", port:3, alsaDev:2, usbPath:"1:22"}
     stat: filesystem stat object
   }

  "devRemoved" : a device has been removed from a USB port, arg is:
   { path: full path to device symlink
     attr: as for "devAdded"
     stat: filesystem stat object (from when device was first detected)
   }

   NOTE: the port assignment is in flusx and being moved into the hub manager instead of being
   an external script. For now the port numbers generated externally are ignored and "recomputed"
   here. The reason for all this is to simplify the interactive editing of port assignments.

*/

class HubMan {
    constructor(matron, root, portmapfile) {
        this.matron = matron
        this.root = root
        this.devs = {} // port-number-indexed map of devices and their properties
        this.parsePortMap(portmapfile)
    }

    // return a list of attached devices
    getDevs() { return this.devs }

    // return the attributes of a device by parsing the filename (splitting on . and then =)
    attrOf(filename) {
        let parts = filename.split('.')
        let attr = { type: parts[0] }
        for (var i=1; i<parts.length; ++i) {
            var sides = parts[i].split('=')
            attr[sides[0]] = sides[1]
        }
        return attr
    }

    // call devChanged on all devices that are already in the /dev/sensorgnome directory
    enumeratePreExistingDevices() {
        console.log("Enumerating existing devices in", this.root)
        var ls = Fs.readdirSync(this.root)
        for (var i of ls) {
            this.devChanged("rename", i)
        }
    }

    // a device changed, either added or removed, figure it out and emit event
    devChanged(event, filename) {
        if (typeof filename !== "string") {
            console.log("Error: HubMan devChanged with no filename?", event, filename)
            return
        }
        let attr = this.attrOf(filename)
        //if (! attr.port_path) return  // not a USB-port device - we don't care

        // temporary hacks, need to change uDev rules instead
        if (attr.type.includes("Cornell")) attr.type = "CTT/CornellRcvr"
        if (attr.type.includes("Cornell")) attr.radio = "CTT/Cornell"
        if (attr.type.includes("funcube")) attr.radio = "VAH"
        if (attr.type.includes("rtlsdr")) attr.radio = "VAH"

        // munge port and path
        let port = attr.radio ? this.findPort(attr.port_path) : "0" // attr.port_path is usb device path        
        attr.port = port
        let path = this.root + "/" + filename // path is full path to device

        try {
            let stat = Fs.statSync(path)
            if (! this.devs[port]) {
                this.devs[port] = {path, attr, stat}
                //console.log("Added " + path + " and devs[port] is " + JSON.stringify(this.devs[port]))
                this.matron.emit("devAdded", this.devs[port])
            }
        } catch (e) {
            // looks like the device has been removed
            // only emit a message if we already knew about this device
            //console.log("Removed " + path + " and devs[port] is " + JSON.stringify(this.devs[port]))
            if (this.devs[port]) {
                this.matron.emit("devRemoved", this.devs[port])
                delete this.devs[port]
            }
        }
    }

    // once listeners have been added to the device manager for device
    // add and remove, the "start" method should be called.
    // I think this guarantees all devices already present and any
    // detected by the OS afterwards will have events emitted for them
    start() {
        try {
            Fs.watch(this.root, (args) => this.devChanged(args))
            // we assume the watch is active once Fs.watch returns, so the following should
            // guarantee an event has been emitted for every device.
            this.enumeratePreExistingDevices()
        } catch (e) {
            if (e instanceof Error && e.code) { // SystemError
                // presumably we failed because /dev/sensorgnome doesn't exist wait 10 seconds for
                // user to plug in a hub and try again.
                console.log("Failed to watch " + this.root + ": " + e)
                setTimeout(()=>this.start(), 10000)
            } else {
                console.log(e.stack)
                death = 1 / 0
            }
        }
    }

    // parse the default port assignments file
    // its syntax is: 1.2.3 -> 4 assigns port 4 to path 1.2.3
    parsePortMap(filename) {
        this.portMap = []
        let lines = Fs.readFileSync(filename).toString().split('\n')
        for (let line of lines) {
            line = line.replace(/#.*/, '').trimEnd() // remove comments
            let mm = line.match(/^([\d.]+)\s*->\s*(\d+)$/)
            if (mm) {
                this.portMap.push({ path: mm[1].replace(/\./g,"_"), port: mm[2] })
            }
        }
        console.log("Default port map: " + this.portMap.map(v=>v.path+"->"+v.port).join(", "))
    }

    // return the port for a device path using the portMap, if not found assign some
    // "random" port number, which is useless except for manual remapping
    findPort(path) {
        for (let p of this.portMap) {
            if (p.path == path) return p.port
        }
        // not found, assign a port number
        for (let i=11; i<100; ++i) {
            let p = ""+i
            if (! this.devs[p]) return p
        }
    }















/* TvE: is this really needed???
    this.VAHstarted =  function() {
        // if device server restarted, re-start all devices as appropriate
        this.enumeratePreExistingDevices()
    }

    this.VAHdied =  function() {
        // if VAH died, forget usbaudio and funcube devices when VAH
        // restarts, we'll re-enumerate
        for (var i in devs) {
            if (devs[i] && devs[i].attr.type.match(/funcube|usbAudio|rtlsdr/)) {
                matron.emit("devRemoved", Util._extend({}, devs[i]))
                delete devs[i]
            }
        }
    }


    // callbacks
    this.this_start = this.start.bind(this)
    this.this_VAHstarted = this.VAHstarted.bind(this)
    this.this_VAHdied = this.VAHdied.bind(this)

    matron.on("VAHstarted", this.this_VAHstarted)
    matron.on("VAHdied", this.this_VAHdied)
*/

}

module.exports = HubMan
