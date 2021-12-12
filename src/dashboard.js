// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

var FSP = require("fs/promises")

class Dashboard {

    constructor(matron) {
        this.matron = matron

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

        // keep track of data file summary stats
        matron.on("data_file_summary", (stats) => FlexDash.set('data_file_summary', stats))
        matron.on("detection_stats", (hourly, daily) => this.updateDetectionStats(hourly, daily))
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
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_gotTag(tag) { FlexDash.set('tag', tag) } // text line describing tag
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) { FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info)) }
    handle_devRemoved(info){ FlexDash.unset(`devices/${info.attr.port}`) }

    // ===== /data file enumeration, download, (and upload?)

    // updateDetectionStats transforms the stats as they come from DataFiles into the format
    // required by the TimePLot widget of FlexDash, i.e. uPlot.
    // uPlot wants an array indexed by time, with each element being an array of values, the first
    // value being the X coordinate, and the rest being the series.
    updateDetectionStats(daily, hourly) {
        // get series names
        let series = Object.values(daily).reduce((series, day) => {
            Object.keys(day).forEach(d => series.add(d))
            return series
        }, new Set())
        series = Array.from(series.values()).sort()
        console.log(`updateDetectionStats: series=${series}`)

        // pivot daily stats
        const ms_per_day = 24*3600*1000
        let today = Math.trunc(Date.now()/ms_per_day)*ms_per_day
        let daily_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const day = today - (99-i)*ms_per_day
            daily_data[i] = [day/1000, ...series.map(s =>
                day in daily && s in daily[day]? daily[day][s] : null)]
        }
        FlexDash.set("detection_series", series.map(s => s=='all' ? 'lotek' : s))
        FlexDash.set("detections_daily", daily_data)

        // pivot hourly stats
        const ms_per_hour = 3600*1000
        let curhour = Math.trunc(Date.now()/ms_per_hour)*ms_per_hour
        let hourly_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const hour = curhour - (99-i)*ms_per_hour
            hourly_data[i] = [hour/1000, ...series.map(s =>
                hour in hourly && s in hourly[hour]? hourly[hour][s] : null)]
        }
        FlexDash.set("detections_hourly", hourly_data)
    }

}

module.exports = Dashboard
