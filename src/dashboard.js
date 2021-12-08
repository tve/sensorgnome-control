// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

var FSP = require("fs/promises")

class Dashboard {

    constructor(matron) {
        this.matron = matron
        this.flexdash = null

        // ===== Event listeners
        for (const ev of [
            'gps', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df'
        ]) {
            this.matron.on(ev, (...args) => {
                if (args.length <= 1) this['handle_'+ev](...args)
                else this['handle_'+ev](...args)
            })
        }
        // this.matron.on('gotTag', this.this_pushTag);
        // this.matron.on('setParam', this.this_pushParam);
        // this.matron.on('setParamError', this.this_setParamError);
        // this.matron.on('vahData', this.this_pushData);
    }
    
    start() {
        this.watch("/data/SGdata")
    }

    genDevInfo(dev) {
        var info = {
            port: dev.attr.port,
            port_path: dev.attr["port_path"] || "--",
            type: dev.attr.type,
        }
        switch (dev.attr.type) {
        case "gps": info.attr = dev.attr.kind; break
        case "CornellTagXCVR": info.attr = "433Mhz"; break
        case "funcubeProPlus": info.attr = "?Mhz"; break
        case "funcubePro": info.attr = "?Mhz"; break
        case "rtlsdr": info.type = dev.attr.prod; info.attr = "?Mhz"; break
        }
        return info
    }
    
    
    handle_gps(fix) { FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_gotTag(tag) { FlexDash.set('tag', tag) } // text line describing tag
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) { FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info)) }
    handle_devRemoved(info){ FlexDash.unset(`devices/${info.attr.port}`) }

    // ===== /data file enumeration, download, (and upload?)



    async updateTree(dir) {
        console.log("updateTree " + dir)
        let tree = []
        try {
            const files = await FSP.readdir(dir)
            for (const file of files) {
                const path = dir + "/" + file
                const stat = await FSP.stat(path)
                if (stat.isDirectory()) {
                    tree = tree.concat(await this.updateTree(path))
                } else {
                    tree.push({ path, size: stat.size, mtime: stat.mtimeMs })
                }
            }
        } catch(e) {
            console.log("Failed to update " + dir + ": " + e);
        }
        return tree
    }

    updateFile(filename) {
        console.log("updateFile " + filename)
    }

    // watch a directory tree and keep a list of info about the files for sending to the dashboard
    async watch(dir) {
        let tree = await this.updateTree(dir)
        console.log("Tree at " + dir + " has " + tree.length + " files")
        FlexDash.set('data_files', tree)

        // let sleep = require('util').promisify(setTimeout)

        // for (;;) {
        //     try {
        //         const watcher = FSP.watch(dir, {recursive:true});
        //         this.updateTree(dir) // watcher is started, get initial state
        //         for await (const {filename} of watcher) {
        //             if (filename) {
        //                 this.updateFile(dir + "/" + filename)
        //             } else {
        //                 this.updateTree(dir + "/" + filename)
        //             }
        //         }
        //     } catch (e) {
        //         console.log("Failed to watch " + dir + ": " + e);
        //         throw e
        //     }
        //     await sleep(30000) // wait 30 secs to see whether we can then watch
        // }
    }

}

module.exports = Dashboard
