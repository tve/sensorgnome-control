// config.js - manage configuration, including deployment and acquisition

var Fs = require("fs")
var Fsp = require("fs").promises

// fields that can be updated
const UPDATABLE = [ 'label', 'memo', 'lotek_freq']

// const defaults = {
//     label: "changeMe",
//     memo: "memo for you about this SensorGnome",
//     lotek_freq: 166.38,
//     module_options: {
//         find_tags: { params: [ /*"--default-freq", 166.38,*/ "--pulse-slop", 1.5 ], enabled: true },
//     },
// }

// SensorGnome deployment info
// class Deployment {
//     constructor(path) {
//         this.path = path
//         try {
//             this.data = { ...defaults, ...JSON.parse(Fs.readFileSync(path).toString()) }
//         } catch (e) {
//             console.log("Error loading deployment info:", e.message, "\n...using defaults.")
//             this.data = { ...defaults }
//         }
//         for (let j in this.data) this[j] = this.data[j] // a bit yucky...
//     }

//     update(new_values) {
//         // update deployment object
//         let changed = false
//         for (let k in this.data) {
//             if (k in new_values) {
//                 // if (k.endsWith("_password_confirm")) {
//                 //     // we ignore the confirmation and handle it specially below
//                 //     continue
//                 // } else if (k.includes("password")) {
//                 //     const kconf = k + "_confirm"
//                 //     if (kconf in this.data) {
//                 //         if (new_values[k] == "") {
//                 //             console.log("Password cannot be empty")
//                 //             return
//                 //         }
//                 //         if (new_values[k].includes("******")) { // probably editing error
//                 //             console.log("Password cannot contain ******")
//                 //             return
//                 //         }
//                 //         if (new_values[k] != new_values[kconf]) {
//                 //             console.log("Password mismatch for", k)
//                 //             return
//                 //         }
//                 //         this.data[kconf] = "" // we don't need a value here
//                 //     }
//                 // }
//                 changed = changed || this.data[k] != new_values[k]
//                 this.data[k] = new_values[k]
//                 this[k] = this.data[k]
//             }
//         }
//         // save to file
//         if (changed) {
//             (async () => {
//                 try {
//                     await Fsp.writeFile(this.path + "~", JSON.stringify(this.data, null, 2))
//                     try {
//                         await Fsp.rename(this.path, this.path + ".bak")
//                     } catch (e) {
//                         if (e.code != "ENOENT") throw e
//                     }
//                     await Fsp.rename(this.path + "~", this.path)
//                 } catch (e) {
//                     console.log("ERROR: failed to save deployment config: ", e)
//                 }
//             })().then(()=>{})
//         }
//     }
// }

// Acquisition settings for receivers and other sensors, including operating plans
class Acquisition {
    constructor(path) {
        this.path = path
        try {
            let text = Fs.readFileSync(path).toString()
            text = text.replace(/\/\/.*$/mg, "") // remove trailing '//' comments
            var d = JSON.parse(text)
            // handle upgrade when we switched from short_label to label in rc-6
            if (d.short_label && !d.label) {
                d.label = d.short_label
                delete d.short_label
            }
            //
            for (let j in d) this[j] = d[j]
            console.log(`lotek freq: ${this.lotek_freq}`)
            if (this.lotek_freq) this.fix_freq(this.lotek_freq)
            console.log(`Aquisition: found ${this.plans.length} plans`)
        } catch (e) {
            console.log("Error loading acquisition.txt:", e)
            throw e
        }
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
                    devLabel: `p${port}`,
                    plan: plans[i],
                }
            }
        }
        return null
    }

    // update the radio frequencies to a given lotek freq
    fix_freq(f) {
        for (let plan of this.plans) {
            for (let dp of plan.devParams || []) {
                if (dp.name == "frequency") {
                    const freq = f-0.004
                    console.log(`setting ${plan.key.devType} frequency to ${freq}`)
                    dp.schedule.value = freq
                }
            }
        }
        console.log(`setting module_options.find_tags.params[1] to ${f}`)
        this.module_options.find_tags.params[1] = f
    }

    // update acquisition object
    update(new_values) {
        let changed = false
        for (let k of UPDATABLE) {
            if (k in new_values) {
                changed = changed || this[k] != new_values[k]
                this[k] = new_values[k]
                console.log("Acquisition: updating", k, "to", new_values[k])
            }
        }
        if (changed && 'lotek_freq' in new_values) this.fix_freq(new_values.lotek_freq)
        // save to file
        if (changed) {
            (async () => {
                try {
                    console.log("Saving ", this.path)
                    const data = {}
                    for (let k of ['label','memo','lotek_freq','gps','plans','module_options'])
                        data[k] = this[k]
                    await Fsp.writeFile(this.path + "~", JSON.stringify(data, null, 2))
                    try {
                        await Fsp.rename(this.path, this.path + ".bak")
                    } catch (e) {
                        if (e.code != "ENOENT") throw e
                    }
                    await Fsp.rename(this.path + "~", this.path)
                } catch (e) {
                    console.log("ERROR: failed to save acquisition config: ", e)
                }
            })().then(()=>{})
        }
    }

}

module.exports = { Acquisition }
