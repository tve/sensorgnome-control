// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

var AR = require('archiver')
const Path = require('path')
const { MotusUploader } = require('./motus_up')

class Dashboard {

    constructor(matron) {
        this.matron = matron

        // ===== Event listeners
        for (const ev of [
            'gotGPSFix', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df', 'sdcardUse', 'vahData',
            // events triggered by a message from FlexDash
            'dash_download', 'dash_upload', 'dash_deployment_update',
        ]) {
            this.matron.on(ev, (...args) => {
                let fn = 'handle_'+ev
                if (!(fn in this)) console.log("Missing Dashboard handler:", ev)
                else if (args.length <= 1) this[fn](...args)
                else this[fn](...args)
            })
        }
        // this.matron.on('gotTag', this.this_pushTag);
        // this.matron.on('setParam', this.this_pushParam);
        // this.matron.on('setParamError', this.this_setParamError);
        // this.matron.on('vahData', this.this_pushData);

        // keep track of data file summary stats
        matron.on("data_file_summary", (stats) => FlexDash.set('data_file_summary', stats))
        matron.on("detection_stats", (hourly, daily) => this.updateDetectionStats(hourly, daily))

        // 5 minutes of detections in 10 second bins for sparklines
        this.detections = {
            ctt: Array(5*6).fill(null),
            lotek: Array(5*6).fill(null),
        }
    }
    
    start() {
        // register download handler with FlexDash
        FlexDash.registerGetHandler("/data-download/:what", (req, res) => this.data_download(req, res))
        setInterval(() => this.detectionShifter(), 10000)

        // set (relatively) static data
        this.setDeployment()
        FlexDash.set('acquisition', JSON.stringify(Acquisition, null, 2))
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
    
    handle_gotGPSFix(fix) { console.log("Dashboard setting GPS fix"); FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_sdcardUse(pct) { FlexDash.set('sdcard_use', pct) }
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) { FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info)) }
    handle_devRemoved(info){ FlexDash.unset(`devices/${info.attr.port}`) }
    
    // ===== Deployment configuration
    
    setDeployment() {
        let dep = { ...Deployment.data }
        delete dep.module_options
        dep.system_password = "********"
        dep.system_password_confirm = "********"
        dep.upload_password = "********"
        FlexDash.set('deployment', dep)
    }

    handle_dash_deployment_update(update) {
        console.log("Updating deployment with", JSON.stringify(update))
        Deployment.update(update)
        this.setDeployment()
    }

    // ===== Tag/Pulse detections for the last 5 minutes

    // shift/roll detection arrays by one element every 10 seconds
    detectionShifter() {
        this.detections.ctt.shift()
        this.detections.ctt.push(0)
        this.detections.lotek.shift()
        this.detections.lotek.push(0)
        FlexDash.set('detections_5min', this.detections)
    }

    handle_gotTag(tag) { 
        this.detections.ctt[this.detections.ctt.length-1]++
        FlexDash.set('detections_5min', this.detections)
    }
    handle_vahData(data) {
        for (const line of data.toString().split("\n")) {
            if (line.startsWith("p")) this.detections.lotek[this.detections.lotek.length-1]++
        }
        FlexDash.set('detections_5min', this.detections)
    }

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

    // user pressed a download button, we need to turn-around and tell the dashboard to
    // actually perform the download (yes, it's a bit convoluted)
    handle_dash_download(what, socket) {
        FlexDash.download(socket, `/data-download/${what}`, 'foo.zip')
    }
    // To download through websocket see: https://stackoverflow.com/questions/29066117

    // Handle GET request to download data files
    // See https://stackoverflow.com/a/61313182/3807231
    data_download(req, resp) {
        console.log("data_download:", req.params.what)
        let files = DataFiles.downloadList(req.params.what)
        if (!files) {
            resp.writeHead(200, {'Content-Type': 'text/plain'})
            resp.send()
            return
        }
        //files = files.slice(0, 100)
        // download date, will be recorded in "database"
        let date = Math.trunc(Date.now()/1000) * 1000
        let filename = "SG" + Machine.machineID + "-" + date + ".zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
        // update the database with the date of the download
        DataFiles.updateUpDownDate('downloaded', files, date)
    }

    handle_dash_upload(_, socket) {
        MotusUp.uploadSoon(true) // force upload asap
    }

}

module.exports = Dashboard
