// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

class Dashboard {

    constructor(matron) {
        this.matron = matron
        this.flexdash = null

        // ===== Event listeners
        for (const ev of ['gps', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved']) {
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
    handle_gotTag(tag) { FlexDash.set('tag', tag) } // text line describing tag
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) { FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info)) }
    handle_devRemoved(info){ FlexDash.unset(`devices/${info.attr.port}`) }

}

module.exports = Dashboard
