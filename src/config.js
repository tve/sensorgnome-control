// config.js - manage configuration, including deplkoyment and acquisition

var Fs = require("fs")
var Fsp = require("fs").promises

const defaults = {
    shortLabel: "changeMe",
    contact: "email/phone/address",
    who: "name of responsible party",
    info: "info about SensorGnome deployment",
}

// SensorGnome deployment info
class Deployment {
    constructor(path) {
        this.path = path
        try {
            this.data = { ...defaults, ...JSON.parse(Fs.readFileSync(path).toString()) }
        } catch (e) {
            console.log("Error loading deployment info:", e)
            this.data = { ...defaults }
        }
        for (let j in this.data) this[j] = this.data[j] // a bit yucky...
    }

    update(new_values) {
        // update deployment object
        let changed = false
        for (let k in this.data) {
            if (k in new_values) {
                changed = changed || this.data[k] != new_values[k]
                this.data[k] = new_values[k]
                this[k] = this.data[k]
            }
        }
        // save to file
        if (changed) {
            (async () => {
                try {
                    await Fsp.writeFile(this.path + "~", JSON.stringify(this.data, null, 2))
                    await Fsp.rename(this.path, this.path + ".bak")
                    await Fsp.rename(this.path + "~", this.path)
                } catch (e) {
                    console.log("ERROR: failed to save deployment config: ", e)
                }
            })().then(()=>{})
        }
    }
}

// Acquisition settings for receivers and other sensors, including operating plans
class Acquisition {
    constructor(path) {
        this.path = path
        let text = Fs.readFileSync(path).toString()
        // remove trailing '//' comments
        text = text.replace(/\/\/.*$/mg, "")
        var d = JSON.parse(text)
        for (let j in d) this[j] = d[j]
    }
    
    // lookup returns the first plan matching the given device type and port
    lookup(port, devType) {
        const plans = this.acquire.plans
        for (let i in plans) {
            if (port.match(new RegExp(plans[i].key.port)) &&
                devType.match(new RegExp(plans[i].key.devType)))
            {
                // kludge: if no USB hub, set port label to 'p0' meaning 'plugged directly into beaglebone'
                return {
                    devLabel: port > 0 ? this.acquire.USB.portLabel[port-1] : "p0",
                    plan: plans[i],
                }
            }
        }
        return null
    }
}

module.exports = { Deployment, Acquisition }
