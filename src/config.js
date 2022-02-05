// config.js - manage configuration, including deplkoyment and acquisition

var Fs = require("fs")
var Fsp = require("fs").promises

const defaults = {
    short_label: "changeMe",
    memo: "memo for you about this SensorGnome",
    upload_username: "motus.org login name",
    upload_password: "",
    module_options: {
        find_tags: { params: [ "--default-freq", 166.38, "--pulse-slop", 1.5 ], enabled: true },
    },
}

// SensorGnome deployment info
class Deployment {
    constructor(path) {
        this.path = path
        try {
            this.data = { ...defaults, ...JSON.parse(Fs.readFileSync(path).toString()) }
        } catch (e) {
            console.log("Error loading deployment info:", e.message, "\n...using defaults.")
            this.data = { ...defaults }
        }
        for (let j in this.data) this[j] = this.data[j] // a bit yucky...
    }

    update(new_values) {
        // update deployment object
        let changed = false
        for (let k in this.data) {
            if (k in new_values) {
                if (k.endsWith("_password_confirm")) {
                    // we ignore the confirmation and handle it specially below
                    continue
                } else if (k.includes("password")) {
                    const kconf = k + "_confirm"
                    if (kconf in this.data) {
                        if (new_values[k] == "") {
                            console.log("Password cannot be empty")
                            return
                        }
                        if (new_values[k].includes("******")) { // probably editing error
                            console.log("Password cannot contain ******")
                            return
                        }
                        if (new_values[k] != new_values[kconf]) {
                            console.log("Password mismatch for", k)
                            return
                        }
                        this.data[kconf] = "" // we don't need a value here
                    }
                }
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
                    try {
                        await Fsp.rename(this.path, this.path + ".bak")
                    } catch (e) {
                        if (e.code != "ENOENT") throw e
                    }
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
        console.log(`Aquisition: found ${this.plans.length} plans`)
    }
    
    // lookup returns the first plan matching the given device type and port
    lookup(port, devType) {
        const plans = this.plans
        for (let i in plans) {
            if (port.match(new RegExp(plans[i].key.port)) &&
                devType.match(new RegExp(plans[i].key.devType)))
            {
                // kludge: if no USB hub, set port label to 'p0' meaning 'plugged directly into beaglebone'
                return {
                    devLabel: port > 0 ? this.USB.portLabel[port-1] : "p0",
                    plan: plans[i],
                }
            }
        }
        return null
    }
}

module.exports = { Deployment, Acquisition }
