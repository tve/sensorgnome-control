// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

const AR = require('archiver')
const Path = require('path')
const CP = require('child_process')
const Pam = require('authenticate-pam')

const top100k = Fs.readFileSync("/opt/sensorgnome/web-portal/top-100k-passwords.txt").toString().split('\n')

// The Dashboard class communicates between the web UI (FlexDash) and the "core" processing,
// mainly using the "Matron" event system. It consists of a number of handlers divided into two
// groups: the "handleSomeEvent" handlers that react to Matron events and propagate the data to
// the dashboard, and the "handle_dash_somet_event" handlers that react to user input events
// from the dashboard and cause some changes to occur.
class Dashboard {

    constructor(matron) {
        this.matron = matron

        // ===== Event listeners
        for (const ev of [
            'gotGPSFix', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df', 'sdcardUse', 'vahData', 'netDefaultRoute', 'netInet', 'netMotus', 'netWifiState',
            'netHotspotState', 'netWifiConfig', 'portmapFile',
            // events triggered by a message from FlexDash
            'dash_download', 'dash_upload', 'dash_deployment_update', 'dash_enable_wifi',
            'dash_enable_hotspot', 'dash_config_wifi', 'dash_update_portmap', 'dash_creds_update',
        ]) {
            this.matron.on(ev, (...args) => {
                let fn = 'handle_'+ev
                try {
                    if (!(fn in this)) console.log("Missing Dashboard handler:", ev)
                    else if (args.length <= 1) this[fn](...args)
                    else this[fn](...args)
                } catch(e) {
                    console.log(`Handler ${fn} failed: ${e}`)
                }
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

        console.log("Dashboard handlers registered")
    }
    
    start() {
        // register download handler with FlexDash
        FlexDash.registerGetHandler("/data-download/:what", (req, res) => this.data_download(req, res))
        setInterval(() => this.detectionShifter(), 10000)

        // set (relatively) static data
        this.setDeployment()
        FlexDash.set('acquisition', JSON.stringify(Acquisition, null, 2))
        FlexDash.set('net_hotspot_ssid', "SG-"+Machine.machineID)
        this.setDashCreds({ current_password: "?????????", new_password: "", confirm_new_password: ""})

        // some static machine info
        FlexDash.set('machineinfo', Machine)
        let uptime = parseInt(Fs.readFileSync("/proc/uptime").toString(), 10)
        if (!(uptime > 0)) uptime = 0
        FlexDash.set('boot_time', Date.now() / 1000 - uptime)
    }
    
    // generate info about a device, called on devAdded
    genDevInfo(dev) {
        var info = {
            port: dev.attr.port,
            port_path: (dev.attr["port_path"] || "--").replace(/\_/g, '.'),
            type: dev.attr.type,
        }
        // switch (dev.attr.type) {
        // case "gps": info.attr = dev.attr.kind; break
        // case "CTT/CornellRcvr": info.attr = "433Mhz"; break
        // case "funcubeProPlus": info.attr = "?Mhz"; break
        // case "funcubePro": info.attr = "?Mhz"; break
        // case "rtlsdr": info.type = dev.attr.prod; info.attr = "?Mhz"; break
        // }
        return info
    }

    // update the number of radios connected on devAdded/Removed
    updateNumRadios() {
        return {
            ctt: Object.values(HubMan.devs).filter(d => d.attr?.radio == "CTT/Cornell").length,
            vah: Object.values(HubMan.devs).filter(d => d.attr?.radio == "VAH").length,
            all: Object.values(HubMan.devs).filter(d => d.attr?.radio).length,
            // bad: radios with invalid port
            bad: Object.keys(HubMan.devs).filter(p => (p < 1 || p > 10) && HubMan.devs[p].attr?.radio).length,
        }
    }
    
    handle_gotGPSFix(fix) { console.log("Dashboard setting GPS fix"); FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_sdcardUse(pct) { FlexDash.set('sdcard_use', pct) }
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) {
        FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info))
        FlexDash.set(`radios`, this.updateNumRadios())
    }
    handle_devRemoved(info){
        FlexDash.unset(`devices/${info.attr.port}`)
        FlexDash.set(`radios`, this.updateNumRadios())
    }
    handle_portmapFile(txt) { FlexDash.set('portmap_file', txt) }
    handle_dash_update_portmap(portmap) { HubMan.setPortmap(portmap) }

    // ===== Network / Internet

    // events from WifiMan, propagate to the UI
    handle_netInet(status) { FlexDash.set('net_inet_status', status) }
    handle_netMotus(status) { FlexDash.set('net_motus_status', status) }
    handle_netDefaultRoute(state) { FlexDash.set('net_default_route', state || "none") }
    handle_netHotspotState(state) { FlexDash.set('net_hotspot_state', state || "??") }
    handle_netWifiState(state) {
        FlexDash.set('net_wifi_state', state || "??")
        FlexDash.set('net_wifi_enabled', this.wifi_state != "INACTIVE" ? "ON" : "OFF")
    }
    handle_netWifiConfig(config) {
        config = Object.fromEntries(['country','ssid','passphrase'].map(k=>[k,config[k]]))
        config.passphrase = "********"
        FlexDash.set('net_wifi_config', config)
    }
    
    // events from the dashboard, change wifi/hotspot state or settings
    handle_dash_enable_wifi(state) { WifiMan.enableWifi(state == "ON").then(() => {}) }
    handle_dash_enable_hotspot(state) { WifiMan.enableHotspot(state == "ON") }
    handle_dash_config_wifi(config) { WifiMan.setWifiConfig(config).then(() => {}) }

    // ===== Deployment configuration
    
    setDeployment() {
        let data = Object.fromEntries(
            Object.entries(Deployment.data).map(e => 
                [ e[0].replace(/_/g,' '),
                  e[0].includes('password') ? "********" : e[1]]
        ))
        delete data['module options']
        let fields = ['short label', 'memo', 'upload username', 'upload password']
        FlexDash.set('deployment', { fields, data })
    }

    handle_dash_deployment_update(update) {
        Deployment.update(Object.fromEntries(
            Object.entries(update).map(e => [e[0].replace(/ /g,'_'), e[1]])))
        this.setDeployment()
    }

    setDashCreds(creds, message) {
        let data = Object.fromEntries(
            Object.entries(creds).map(e => [ e[0].replace(/_/g,' '), e[1]])
        )
        let fields = ['current password', 'new password', 'confirm new password']
        if (message) {
            console.log(`setDashCreds: ${message}`)
            data['message'] = message
            fields.unshift('message')
        }
        FlexDash.set('system_creds', { fields, data })
    }

    handle_dash_creds_update(update) {
        if (!(update['current password'] && update['new password'] && update['confirm new password'])) return
        let cp = update['current password'], np = update['new password']
        if (np != update['confirm new password']) {
            update['confirm new password'] = ""
            this.setDashCreds(update, "new passwords don't match")
            return
        }
        if (np.length < 8 || np.length > 32) {
            this.setDashCreds(update, "password must be 8 to 32 characters long")
            return
        }
        if (top100k.includes(np)) {
            this.setDashCreds(update, "please choose a less common password :-)")
            return
        }
        Pam.authenticate('pi', cp, (err) => {
            if (err) {
                update['current password'] = ""
                this.setDashCreds(update, "incorrect current password")
            } else {
                try {
                    CP.execFileSync("/usr/sbin/chpasswd", { input: `pi:${np}\n` })
                } catch(e) {
                    return
                }
                this.setDashCreds({ current_password: "", new_password: "", confirm_new_password: ""},
                    "password updated")
            }
        }, {serviceName: 'login', remoteHost: 'localhost'})
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
        const secs_per_day = 24*3600
        let today = Math.trunc(Date.now()/1000/secs_per_day)*secs_per_day
        let daily_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const day = today - (99-i)*secs_per_day
            daily_data[i] = [day, ...series.map(s =>
                day in daily && s in daily[day]? daily[day][s] : null)]
        }
        FlexDash.set("detection_series", series.map(s => s=='all' ? 'lotek' : s))
        FlexDash.set("detections_daily", daily_data)

        // pivot hourly stats
        const secs_per_hour = 3600
        let curhour = Math.trunc(Date.now()/1000/secs_per_hour)*secs_per_hour
        let hourly_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const hour = curhour - (99-i)*secs_per_hour
            hourly_data[i] = [hour, ...series.map(s =>
                hour in hourly && s in hourly[hour]? hourly[hour][s] : null)]
        }
        FlexDash.set("detections_hourly", hourly_data)
    }

    // user pressed a download button, we need to turn-around and tell the dashboard to
    // actually perform the download (yes, it's a bit convoluted)
    // what: new/all/last
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
        // download date, will be recorded in "database"
        let date = Math.trunc(Date.now()/1000)
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
