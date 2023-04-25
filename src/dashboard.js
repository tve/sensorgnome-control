// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

const AR = require('archiver')
const Path = require('path')
const CP = require('child_process')
//const Pam = require('authenticate-pam')
const Fs = require('fs')
const crypto = require('crypto')
const TimeSeries = require('./timeseries.js')


const top100k = Fs.readFileSync("/opt/sensorgnome/web-portal/top-100k-passwords.txt").toString().split('\n')

const TAGDBFILE   = "/etc/sensorgnome/SG_tag_database.sqlite" // FIXME: needs to come from main.js...
const wifi_hotspot = "/opt/sensorgnome/wifi-button/wifi-hotspot.sh"
const remote_access = "/etc/sensorgnome/remote.json"
const SixfabUpsHat = "/opt/sensorgnome/ups-hat/ups_manager.py"
const vnstat = "/usr/bin/vnstat"
const ts_dir = "/data/ts"

const LotekFreqs = [ 166.380, 150.100, 150.500 ]

// The Dashboard class communicates between the web UI (FlexDash) and the "core" processing,
// mainly using the "Matron" event system. It consists of a number of handlers divided into two
// groups: the "handleSomeEvent" handlers that react to Matron events and propagate the data to
// the dashboard, and the "handle_dash_some_event" handlers that react to user input events
// from the dashboard and cause some changes to occur.
class Dashboard {

    constructor(matron) {
        this.matron = matron

        // ===== Event listeners
        for (const ev of [
            // normal events funneled through matron (i.e. from app)
            'gotGPSFix', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df', 'sdcardUse', 'vahData', 'netDefaultRoute', 'netInet', 'netMotus', 'netWifiState',
            'netHotspotState', 'netWifiConfig', 'portmapFile', 'tagDBInfo', 'motusRecv',
            'motusUploadResult', 'netDefaultGw', 'netDNS', 'lotekFreq', 'netCellState', 'netCellReason',
            'netCellInfo', 'netCellConfig',
            // dashboard events triggered by a message from FlexDash
            'dash_download', 'dash_upload', 'dash_deployment_update', 'dash_enable_wifi',
            'dash_enable_hotspot', 'dash_config_wifi', 'dash_update_portmap', 'dash_creds_update',
            'dash_upload_tagdb', 'dash_df_enable', 'dash_df_tags', 'dash_software_reboot',
            'dash_software_enable', 'dash_software_check', 'dash_software_upgrade',
            'dash_allow_shutdown', 'dash_software_shutdown', 'dash_software_restart',
            'dash_download_logs', 'dash_lotek_freq_change', 'dash_config_cell', 'dash_toggle_train',
            'dash_remote_cmds', 'dash_detection_range'
        ]) {
            this.matron.on(ev, (...args) => {
                let fn = 'handle_'+ev
                try {
                    if (!(fn in this)) console.log("Missing Dashboard handler:", ev)
                    else if (args.length <= 1) this[fn](...args)
                    else this[fn](...args)
                } catch(e) {
                    console.log(`Handler ${fn} failed:`, e)
                }
            })
        }

        // keep track of data file summary stats
        matron.on("data_file_summary", (stats) => FlexDash.set('data_file_summary', stats))
        matron.on("detection_stats", (hourly, daily) => this.updateDetectionStats(hourly, daily))

        // 5 minutes of detections in 10 second bins for sparklines
        this.detections = {
            ctt: Array(5*6).fill(null),
            lotek: Array(5*6).fill(null),
        }
        this.detection_log = []

        // direction finding log
        this.df_enable = false
        this.df_tags = {tag1: "1.1", tag2: '78664c3304'}
        this.df_log = []

        // time-series
        this.ts = {}
        this.tsRefreshInterval = null
        Fs.mkdirSync(ts_dir, {recursive: true})
        this.handle_dash_detection_range(TimeSeries.ranges[0])
        setInterval(() => this.tsSave(), 60000)

        this.handle_motusRecv({})

        console.log("Dashboard handlers registered")
    }
    
    start() {
        // register download handler with FlexDash
        FlexDash.registerGetHandler("/data-download/:what", (req, res) => this.data_download(req, res))
        FlexDash.registerGetHandler("/logs-download/:what", (req, res) => this.logs_download(req, res))

        setInterval(() => this.detectionShifter(), 10000)

        //setInterval(() => this.tsGenRandom(), 8300)

        // set (relatively) static data
        this.setDeployment()
        FlexDash.set('acquisition', JSON.stringify(Acquisition, null, 2))
        FlexDash.set('net_hotspot_ssid', Machine.machineID)
        this.setDashCreds({ current_password: "?????????", new_password: "", confirm_new_password: ""})
        this.setRemoteManagement()

        // some static machine info
        FlexDash.set('machineinfo', Machine)
        setTimeout(()=>FlexDash.set('machineinfo', Machine), 15000) // sdCardSize comes delayed
        FlexDash.set('software/enable', false)
        FlexDash.set('software/enable_upgrade', false)
        FlexDash.set('software/enable_shutdown', false)
        this.allow_poweroff = false
        FlexDash.set("software/available", "Not yet checked...")
        FlexDash.set("software/log", "- empty -")
        this.setDashTrain()
        this.getUptime()
        this.matron.on("gpsSetClock", () => this.getUptime())

        // direction finding info is not saved between restarts...
        FlexDash.set('df_enable', 'OFF')
        FlexDash.set('df_tags', this.df_tags)
        FlexDash.set('df_log', "")

        FlexDash.monitoring = this.monitoring.bind(this)

        //this.startUpsHatUpdater()

        setTimeout(() => this.updateNetUsage(), 10*1000)
        setInterval(() => this.updateNetUsage(), 300*1000)
        
    }
    
    getUptime() {
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
    
    handle_gotGPSFix(fix) { FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_sdcardUse(pct) { FlexDash.set('sdcard_use', pct) }
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) {
        FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info))
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsAddDevice(info)
    }
    handle_devRemoved(info){
        FlexDash.unset(`devices/${info.attr.port}`)
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsRemoveDevice(info)
    }
    handle_portmapFile(txt) { FlexDash.set('portmap_file', txt) }
    handle_dash_update_portmap(portmap) { HubMan.setPortmap(portmap) }
    handle_tagDBInfo(data) { FlexDash.set('tagdb', data) }
    handle_motusUploadResult(data) { FlexDash.set('motus_upload', data) }
    handle_lotekFreq(f) { FlexDash.set('lotek_freq', f) }

    // ===== Network / Internet

    // events from WifiMan, propagate to the UI
    handle_netInet(status) { FlexDash.set('net_inet_status', status) }
    handle_netMotus(status) { FlexDash.set('net_motus_status', status) }
    handle_netDefaultRoute(state) { FlexDash.set('net_default_route', state || "none") }
    handle_netDefaultGw(state) { FlexDash.set('net_default_gw', state) }
    handle_netDNS(state) { FlexDash.set('net_dns', state) }
    handle_netHotspotState(state) { FlexDash.set('net_hotspot_state', state || "??") }
    handle_netWifiState(state) {
        FlexDash.set('net_wifi_state', state || "??")
        FlexDash.set('net_wifi_enabled', state != "INACTIVE" ? "ON" : "OFF")
    }
    handle_netWifiConfig(config) {
        config = Object.fromEntries(['country','ssid','passphrase'].map(k=>[k,config[k]]))
        config.passphrase = "********"
        FlexDash.set('net_wifi_config', config)
    }
    handle_netCellState(state) { FlexDash.set('cellular/state', state || "??") }
    handle_netCellReason(reason) { FlexDash.set('cellular/reason', reason || "") }
    handle_netCellConfig(data) {
        FlexDash.set('cellular/config', data || {})
        FlexDash.set('cellular/config_labels', Object.keys(data||{}))
    }
    handle_netCellInfo(info) {
        FlexDash.set('cellular/info', info || {})
        FlexDash.set('cellular/info_labels', Object.keys(info||{}))
    }
    
    // events from the dashboard, change wifi/hotspot/cell state or settings
    handle_dash_enable_wifi(state) { WifiMan.enableWifi(state == "ON").then(() => {}) }
    handle_dash_enable_hotspot(state) { WifiMan.enableHotspot(state == "ON") }
    handle_dash_config_wifi(config) { WifiMan.setWifiConfig(config).then(() => {}) }
    handle_dash_config_cell(config) { CellMan.setCellConfig(config) }

    // upload info
    handle_motusRecv(info) {
        const dash = {
            project_id: info.project || "UNSET",
            deployment_status: info.status || "UNKNOWN",
            station_name: info.deployment,
            project_color: info.project ? "green" : "red",
            status_color: info.status == "active" ? "green" : "red",
        }
        FlexDash.set('motus_recv', dash)
    }

    // ===== Pulses and tag time-series

    // generate a filename for a device's time-series
    tsFilename(dev) {
        let prefix
        switch (dev.attr.type) {
        case "CTT/CornellRcvr": prefix = "ctt"; break
        case "funcubeProPlus": prefix = "lotek"; break
        case "funcubePro": prefix = "lotek"; break
        case "rtlsdr": prefix = "lotek"; break
        default: return null
        }
        return `${prefix}-${dev.attr.port}`
    }

    // device got added, init the time-series for it
    tsAddDevice(dev) {
        const port = dev.attr.port
        if (dev.attr.type == "CTT/CornellRcvr") {
            // CTT devices only produce tag detections
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "ctt-tags-"+dev.attr.port),
            }
        } else if (dev.attr.type == "funcubeProPlus" || dev.attr.type == "funcubePro" || dev.attr.type == "rtlsdr") {
            // Lotek devices produce tag detections, pulses and noise figures
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "lotek-tags-"+dev.attr.port),
                pulses: new TimeSeries(ts_dir, "lotek-pulses-"+dev.attr.port),
                noise: new TimeSeries(ts_dir, "lotek-noise-"+dev.attr.port),
            }
        }
        console.log("tsAddDevice", dev.attr.port, port)
    }

    tsRemoveDevice(dev) {
        if (!this.ts[dev.attr.port]) return
        for (const ts of Object.values(this.ts[dev.attr.port])) ts.close()
        delete this.ts[dev.attr.port]
    }

    // process a tag detection from a device
    tsGotTag(tag) {
        // T3,1681004846.412,0FE36400,-96,v2
        // L6,1681004878.702,TestTags#1.1@166.38:25.1,3.809,0.011,-25.5,1.18,-54.4,1,3,0.0005,4.96e-05,166.38
        try {
            const f = tag.split(',')
            if (f.length < 2) return
            const mm = f[0].match(/^([A-Z])(\d+)/)
            if (!mm) return
            const port = mm[2]
            const time = Math.round(parseFloat(f[1])*1000)
            if (this.ts[port]?.tags) this.ts[port].tags.add(time, 1)
            if (this.ts[port]?.noise && f.length >= 8) {
                const noise = parseFloat(f[7])
                this.ts[port].noise.avg(time, noise)
            }
        } catch (e) {
            console.warn("tsGotTag", e)
        }
    }

    // process a pulse from a lotek radio
    tsGotPulse(info) {
        // p6,1681004979.0929,3.785,-29.66,-54.81
        try {
            const f = info.split(',')
            if (f.length < 5) return
            const mm = f[0].match(/^p(\d+)/)
            if (!mm) return
            const port = mm[1]
            const time = Math.round(parseFloat(f[1])*1000)
            const noise = parseFloat(f[4])
            if (this.ts[port]?.pulses) this.ts[port].pulses.add(time, 1)
            if (this.ts[port]?.noise) this.ts[port].noise.avg(time, noise)
        } catch (e) {
            console.warn("tsGotPulse", e)
        }
    }

    // update a graph, what: lotek-tags, lotek-pulses, lotek-noise, ctt-tags
    tsShow(what) {
        const [prefix, series] = what.split('-')
        // assemble the set of time-series to show
        const tsSet = []
        const labels = []
        for (const port in this.ts) {
            if (series in this.ts[port] && this.ts[port][series].name.startsWith(prefix)) {
                tsSet.push(this.ts[port][series])
                labels.push(`port ${port}`)
            }
        }
        //console.log(`tsShow: ${what} ${tsSet.length} devices:`, tsSet.length)
        // get the data together
        if (tsSet.length == 0) {
            FlexDash.set(`detections/${series}`, { data: [], labels })
            return
        }
        const now = Date.now()
        const range = TimeSeries.ranges[this.ts_ix]
        const [times, values] = tsSet[0].get(range, now)
        //console.log("Got:", values)
        const interval = TimeSeries.intervals[this.ts_ix]
        const fct = series == 'noise'
            ? v => v
            : v => v == null ? null : v * 3600*1000 / interval
        const data = times.map((t, i) => [Math.floor(t/1000), fct(values[i])])
        for (let i = 1; i < tsSet.length; i++) {
            const [times, values] = tsSet[i].get(range, now)
            if (times.length != data.length) throw new Error("tsShow: times length mismatch")
            if (times[0] != data[0][0]) throw new Error("tsShow: data start mismatch")
            for (let j=0; j<data.length; j++) data[j].push(fct(values[j]))
        }
        const title = what.replace('-',' ') + " (" + range + ")" // can't set dynamic title :-(
        FlexDash.set(`detections/${what}`, { data, labels, title })
        //console.log(`tsShow: ${what} ${now} ${data.length} points, labels=${labels}`)
        //onsole.log(data)
    }

    // generate some random data, useful for testing only
    tsGenRandom() {
        const now = Date.now()
        console.log("tsGenRandom", Object.keys(this.ts))
        for (const port in this.ts) {
            const ts = this.ts[port]
            if (ts.pulses) {
                this.tsGotTag(`L${port},${now/1000},tag,0,0,0,0,${-50-Math.random()*10},0,0,0,0,166.38`)
                this.tsShow('lotek-tags')
                this.tsGotPulse(`p${port},${now/1000},0,0,${-50-Math.random()*10}`)
                this.tsShow('lotek-pulses')
                this.tsShow('lotek-noise')
            } else {
                this.tsGotTag(`T${port},${now/1000},12345678,0`)
                this.tsShow('ctt-tags')
            }
        }
    }

    // refresh the currently shown graphs
    tsRefresh() {
        try {
            // catch up all the graphs
            const now = Date.now()
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    const fill = series == 'noise' ? null : 0
                    ts[series].catch_up(now, fill)
                }
            }
            // display
            for (const what of ['lotek-tags', 'lotek-pulses', 'lotek-noise', 'ctt-tags']) {
                this.tsShow(what)
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // save all the time-series to file
    tsSave() {
        try {
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    ts[series].save() // only does something if it's dirty
                }
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // the user clicked a range button, switch the range for the charts
    handle_dash_detection_range(range) {
        try {
            const ix = TimeSeries.ranges.indexOf(range)
            if (ix < 0) { console.log("handle_dash_detection_range: bad range", range); return }

            let intv = TimeSeries.intervals[ix]/1000 // in seconds
            if (intv < 120) intv += "s"
            else if (intv < 7200) intv = Math.round(intv/60) + "m"
            else if (intv < 2*86400) intv = Math.round(intv/3600) + "h"
            else intv = Math.round(intv/86400) + "d"
            FlexDash.set("detections/interval", intv)

            this.ts_ix = ix
            this.tsRefresh()

            if (this.tsRefreshInterval) clearInterval(this.tsRefreshInterval)
            this.tsRefreshInterval = setInterval(() => this.tsRefresh(), TimeSeries.intervals[ix])
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // ===== Deployment configuration
    
    setDeployment() {
        // let data = Object.fromEntries(
        //     Object.entries(Deployment.data).map(e => 
        //         [ e[0].replace(/_/g,' '),
        //           e[0].includes('password') ? "********" : e[1]]
        // ))
        // delete data['module options']
        // let fields = ['short label', 'memo', 'upload username', 'upload password']
        FlexDash.set('deployment', {
            fields: ["memo"],
            // fields: ["label","memo"],
            data: { label: Acquisition.label, memo: Acquisition.memo },
         })
    }

    handle_dash_deployment_update(update) {
        console.log("handle_dash_deployment_update", update)
        Acquisition.update(Object.fromEntries(
            Object.entries(update).map(e => [e[0].replace(/ /g,'_'), e[1]])))
        this.setDeployment()
        // FlexDash.set('motus_login', `checking...`)
        // this.matron.emit("motus-creds")
    }

    handle_dash_lotek_freq_change() {
        // update the acquisition settings
        let ix = LotekFreqs.indexOf(Acquisition.lotek_freq)
        ix = (ix+1) % LotekFreqs.length
        const f = LotekFreqs[ix]
        Acquisition.update({lotek_freq: f})
        // restart the radios and tag finder
        this.matron.emit("lotekFreqChg", f)
        HubMan.resetDevices()
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
        //Pam.authenticate(Machine.username, cp, (err) => {
        FlexDash.py_auth(Machine.username, cp, (err) => {
            if (err) {
                update['current password'] = ""
                this.setDashCreds(update, "incorrect current password")
            } else {
                // hash the pwd for the hotspot, uses the SSID as salt!
                const hpw = crypto.pbkdf2Sync(np, Machine.machineID, 4096, 256 / 8, "sha1").toString("hex")
                try {
                    CP.execFileSync("/usr/sbin/chpasswd", { input: `${Machine.username}:${np}\n` })
                    CP.execFileSync(wifi_hotspot, ["mode", "WPA-PSK", hpw])
                } catch(e) {
                    console.log("creds_update error", e)
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

    detectionLogPush(data) {
        this.detection_log.push(data)
        let dll = this.detection_log.length
        if (dll > 100) this.detection_log.splice(0, dll-100)
        FlexDash.set("detection_log", this.detection_log.join("\n"))
    }

    handle_gotTag(tag) {
        if (!tag.match(/^[A-Za-z]?[0-9]/)) return
        if (!tag.match(/^[A-Za-z]/)) tag = "L" + tag // "Lotek" prefix, ugh
        if (tag.startsWith("T")) this.detections.ctt[this.detections.ctt.length-1]++
        FlexDash.set('detections_5min', this.detections)
        this.detectionLogPush(tag.trim().replace(/^/gm,"TAG: "))
        this.tsGotTag(tag.trim())
        // direction finding
        if (this.df_enable && this.df_tags) {
            let tt = tag.trim().split(",")
            if (tt.length < 4) return
            let name = tt[2].replace(/.*#([^@]+)@.*/,'$1') // lotek mess
            let signal = tt.length > 5 ? tt[5] : tt[3]
            if (name == this.df_tags.tag1 || name == this.df_tags.tag2) {
                this.dfLogPush(name, signal)
            }
        }
    }

    handle_vahData(data) {
        for (const line of data.toString().split("\n")) {
            if (line.startsWith("p")) {
                this.detections.lotek[this.detections.lotek.length-1]++
                this.detectionLogPush("PLS: " + line.trim())
                this.tsGotPulse(line.trim())
            }
        }
        FlexDash.set('detections_5min', this.detections)
    }

    // handle tag database upload
    handle_dash_upload_tagdb(phase, info, resp) {
        if (phase === 'begin' && resp) {
            resp(info.size > 0 && info.size < 10*1024*1024 && TAGDBFILE)
        } else if (phase === 'done') {
            console.log("Tag DB upload done:", info)
            this.matron.emit("tagDBChg")
        }
    }

    // ===== Direction finding

    handle_dash_df_tags(tags) {
        if (typeof tags === 'object' && 'tag1' in tags && 'tag2' in tags) {
            this.df_tags = tags
            FlexDash.set("df_tags", tags)
            console.log("DF tags: " + JSON.stringify(tags))
        }
    }

    handle_dash_df_enable(en) {
        this.df_enable = en == true || en == "ON"
        FlexDash.set('df_enable', this.df_enable ? "ON" : "OFF")
        console.log("DF " + (this.df_enable ? "enabled" : "disabled"))
    }

    dfLogPush(name, signal) {
        const ts = new Date().toISOString().replace(/.*T/, '').replace(/\..+/, '')
        this.df_log.push(ts + " " + name + " " + signal + "dBm")
        let dfl = this.df_log.length
        // keep a fixed number of lines
        if (dfl > 10) this.df_log.splice(0, dfl-10)
        //console.log("df log: " + this.df_log.join(" | "))
        FlexDash.set("df_log", this.df_log.join("\n"))
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
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + ".zip"
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
        let date = Math.trunc(now.getTime()/1000)
        DataFiles.updateUpDownDate('downloaded', files, date)
    }

    handle_dash_upload(_, socket) {
        MotusUp.uploadSoon(true) // force upload asap
    }

    // ===== Software updates

    // toggle to enable/disable all the software update functionality
    handle_dash_software_enable(value) {
        FlexDash.set('software/enable', value)
        if (!value) FlexDash.set('software/enable_upgrade', false)
    }
    // toggle to enable/disable all the software update functionality
    handle_dash_allow_shutdown(value) {
        FlexDash.set('software/enable_shutdown', value)
        this.allow_poweroff = value
    }

    // show and toggle release train
    handle_dash_toggle_train(value) {
        FlexDash.set('software/train', value)
        if (['stable','testing'].includes(value)) {
            Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
                if (err) {
                    console.log("Error reading sensorgnome.list:", err)
                    return
                }
                data = data.toString().replace(/(stable|testing)/, value)
                Fs.writeFile('/etc/apt/sources.list.d/sensorgnome.list', data, (err) => {
                    if (err) {
                        console.log("Error writing sensorgnome.list:", err)
                        return
                    }
                })
            })
        }
    }
    setDashTrain() {
        Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
            if (err) {
                console.log("Error reading sensorgnome.list:", err)
                return
            }
            let train = data.toString().match(/(stable|testing)/)
            if (train) FlexDash.set('software/train', train[1])
        })
    }

    handle_dash_software_restart() { Upgrader.restart() }
    handle_dash_software_reboot() { Upgrader.reboot() }
    handle_dash_software_shutdown() {
        if (this.allow_poweroff) Upgrader.shutdown()
    }
    handle_dash_software_check() { Upgrader.check() }
    handle_dash_software_upgrade(what) { Upgrader.upgrade(what) }

    // download logs button (what must be "all" for now)
    handle_dash_download_logs(what, socket) {
        FlexDash.download(socket, `/logs-download/${what}`, 'logs.zip')
    }

    // Handle GET request to download log files
    // See https://stackoverflow.com/a/61313182/3807231
    logs_download(req, resp) {
        console.log("log_download:", req.params.what)
        let files = Fs.readdirSync("/var/log", 'utf8')
        files = files.filter(f => f.startsWith("sg-control")).map(f=>'/var/log/'+f)
        files.push("/var/log/syslog")
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + "-logs.zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} log files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
    }

    // ===== Remote management

    setRemoteManagement(new_config) {
        Fs.readFile(remote_access, (err, data) => {
            if (err) {
                console.log(`Error reading ${remote_access}: ${err}`)
                return
            }
            try {
                const config = JSON.parse(data)
                if (new_config) {
                    Object.assign(config, new_config)
                    Fs.writeFile(remote_access, JSON.stringify(config), (err) => {
                        if (err) console.log(`Error writing ${remote_access}: ${err}`)
                    })
                }
                FlexDash.set('remote/cmds', config.commands ? "enabled" : "disabled")
                config.webui = false // always show webui as disabled for now
                FlexDash.set("remote/webui", config.webui ? "enabled" : "disabled")
            } catch(e) {
                console.log(`Error parsing ${remote_access}: ${e}`)
            }
        })
    }

    handle_dash_remote_cmds(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ commands: v })
    }
    handle_dash_remote_webui(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ webui: v })
    }

    // ===== Sixfab UPS HAT information

    // get all the available info about the UPS HAT from a custom python script that queries the
    // sixfab power-api. This produces a bunch of json metrics which we just dump into flexdash.
    // It returns true if successful, false otherwise
    getUpsHatInfo() {
        return new Promise((resolve, reject) => {
            ChildProcess.execFile(SixfabUpsHat, (code, stdout, stderr) => {
                //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
                if (code || stderr) reject(new Error(`${SixfabUpsHat} failed: ${stderr||code}`))
                try {
                    let data = JSON.parse(stdout)
                    FlexDash.set('ups_hat', data)
                    resolve(true)
                    // if the UPS HAT says that we should shut down, do it
                    if (data['shutdown']) {
                        console.log("UPS HAT says we should shut down")
                        MotusUp.uploadSoon(true) // force upload asap
                        // shut down before next HAT query
                        setTimeout(() => Upgrader.shutdown(), 50*1000)
                    }
                } catch (e) {
                    //console.log(`Got : ${stdout}`)
                    FlexDash.set('ups_hat', {input: {status:"error querying HAT"}, system:{}, battery:{}})
                    reject(new Error(`${SixfabUpsHat} failed: ${e}`))
                }
            })
        })
    }

    startUpsHatUpdater() {
        let ok = this.getUpsHatInfo()
        .then(() => {
            setInterval(() => this.getUpsHatInfo(), 60*1000)
        })
        .catch((e) => {
            console.log("Assuming no Sixfab UPS HAT:", e.message)
            FlexDash.set('ups_hat', {input: {status:"HAT not installed"}, system:{}, battery:{}})
        })
    }

    // ===== Network usage collected by vnStat

    updateNetUsage() {
        ChildProcess.execFile(vnstat, (code, stdout, stderr) => {
            //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
            if (code || stderr) {
                console.log(`${vnstat} failed: ${stderr||code}`)
                return
            }
            try {
                // rows: [iface, when, rx, tx, total, predicted]
                const data = []
                let iface = '??'
                for (const line of stdout.split('\n')) {
                    const words = line.split(/  */)
                    if (words[0] == "") words.shift()
                    if (words.length == 1 && words[0].endsWith(':')) {
                        data.push(['','',words[0].slice(0,-1),'',''])
                    } else if (words.length == 0) {
                        // ignore
                    } else if (words[0].endsWith(':')) {
                        // ignore ("Not enough data available yet")
                    } else if (words[0] == 'rx') {
                        // ignore (header)
                    } else if (words[3] == '/') {
                        let row = [words.shift()]
                        while (words.length > 0) {
                            const w = words.shift()
                            if (w == '--') row.push('--')
                            else row.push(`${w} ${words.shift()}`)
                            if (words.length > 0 && words[0] == '/') words.shift()
                        }
                        data.push(row)
                    }
                }
                FlexDash.set('net_usage_data', data)
                FlexDash.set('net_usage_columns', ['when', 'rx', 'tx', 'total', 'predicted'])
            } catch (e) {
                //console.log(`Got : ${stdout}`)
                FlexDash.set('net_usage_data', {})
                console.log(`${vnstat} parsing failed:`, e)
            }
        })
    }

    // ===== Return monitoring data in json format
    // This is in the dashboard module because most of the data is grabbed from the dashboard
    // state variables.
    monitoring() {
        return {
            radios: {
                counts: FlexDash.get('radios'),
                devices: FlexDash.get('devices'),
            },
            detections: {
                series: FlexDash.get('detection_series'),
                daily: FlexDash.get('detections_daily'),
                hourly: FlexDash.get('detections_hourly'),
                tagdb: FlexDash.get('tagdb'),
            },
            gps: FlexDash.get('gps'),
            uploads: {
                result: FlexDash.get('motus_upload'),
                project_id: FlexDash.get('motus_recv/project_id'),
                deployment_status: FlexDash.get('motus_recv/status'),
            },
            files: {
                summary: FlexDash.get('data_file_summary'),
            },
            network: {
                wifi: FlexDash.get('net_wifi_state'),
                hotspot: FlexDash.get('net_hotspot_state'),
                cell: FlexDash.get('cellular/state'),
                inet: FlexDash.get('net_default_route'),
            },
        }
    }

}

module.exports = Dashboard
