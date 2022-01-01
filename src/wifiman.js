// wifiman - manage wifi settings, bridging between UI and scripts in sg-support
// Copyright ©2021 Thorsten von Eicken

// Networking states:
// - no default route
// - default route via wifi, ethernet or cell (usb)
// - google connectivity-check reachable
// - Motus reachable
//
// Wifi (client) & Hotspot configs:
// - enabled/disabled
// - ssid & passphrase
// - country code

// Wifi client is managed through wpa_cli, the command-line interface to wpa_supplicant.
// This is also what raspi-config uses internally, so everything should be compatible.
// The "wlan0" interface name is hard-coded. At some point this may have to change or
// udev rules could be created for other devices so they appear as wlan0...
// Hotspot (wifi access point) is managed using the hotspot script in sensorgnome-support,
// which uses hostapd internally.

const centra = require("./centra.js")
const Fsp = require("fs").promises

const IP_CMD = "/usr/sbin/ip"
const route_map = { wlan0: "wifi", eth0: "eth", usb: "cell" }

const URL_CONN = 'http://connectivitycheck.gstatic.com/generate_204' // Android connectivity check
const URL_MOTUS = 'https://www.motus.org/data' // Motus connectivity check
const INET_RECHECK_INIT = 10 * 1000
const INET_RECHECK_MAX = 3600 * 1000

const HOTSPOT_SCRIPT = "/opt/sensorgnome/wifi-button/scripts/wifi-hotspot.sh"
const WPA_CLI = "/usr/sbin/wpa_cli"

// wpa_cli status: INACTIVE, ..., COMPLETED

class WifiMan {
    constructor(matron) {
        this.matron = matron
        // managing "ip monitor route" child command
        this.child = null
        this.relaunching = false
        // networking state
        this.default_route = null
        this.inet_status = null
        this.motus_status = null
        this.recheck_time = INET_RECHECK_INIT
        this.check_timer = null
    }

    start() {
        this.launchRouteMonitor()
        setTimeout(() => this.getDefaultRoute(), 3000)
        this.getWifiConfig()
    }

    // ===== monitoring default route

    // launch ip monitor process to monitor default route changes
    launchRouteMonitor() {
        let stdio = [ 'ignore', 'pipe', 'inherit' ]
        let child = ChildProcess.spawn(IP_CMD, ["monitor", "route"], { stdio })
            .on("exit", (code) => this.childDied("Process exited, code=" + code))
            .on("error", (err) => this.childDied(err))
            .on("spawn", () => this.getDefaultRoute())
        // ip monitor route prints the change, but that doesn't really help us because deleting
        // a default route doesn't mean there's not a second one that still works (for example)
        // so we neet to ask ip route what it would do now
        child.stdout.on("data", (chunk) => this.getDefaultRoute())
        this.child = child
        this.relaunching = false
    }

    // ip monitor process died, relaunch in a bit
    childDied(err) {
        if (this.relaunching) return
        this.relaucnhing = true
        this.child = null
        setTimeout(() => this.launch(), 1000)
    }

    // fetch the current default route using ip route command, using 1.1.1.1 as target for 'route get'
    // using 'route show default' is messy if there's more than one default route, e.g. if adding
    // wifi on top of ethernet
    getDefaultRoute() {
        ChildProcess.execFile(IP_CMD, ["route", "get", "1.1.1.1"], (code, stdout, stderr) => {
            this.default_route = null
            if (stdout) this.readRoute(stdout)
            this.getInterfaceStates()
            setTimeout(() => this.testConnectivity(), 1000)
        })
    }
    
    // set this.default_route to null|"wifi"|"ethernet"|"cell"|"other"
    readRoute(lines) {
        let route = null
        for (let line of lines.split("\n")) {
            // match: default via 192.168.0.1 dev wlan0 proto dhcp src 192.168.0.93 metric 303
            let mm = line.match(/^1.1.1.1\s+via\s+(\S+)(\s+dev\s+(\S+))?/)
            if (mm && mm.length == 4) {
                route = mm[3] || "other"
                console.log(`Default route: ${route} (${line})`)
            }
        }
        // map device names to "english"
        if (route && route_map[route]) route = route_map[route]
        // publish
        //console.log("Default route:", route)
        this.default_route = route
        this.matron.emit("netDefaultRoute", route || "none")
    }

    // ===== wifi and hotspot monitoring

    // "ideally" we'd run "ip monitor link" to catch interface status changes, but it's a lot
    // simpler to just tack onto the route monitoring because interface changes also cause
    // route changes...

    getInterfaceStates() {
        this.execFile(IP_CMD, ["link"])
        .then(stdout => {
            //this.wifi_state = null
            this.hotspot_state = null
            this.readIfaces(stdout)
        })
        .catch(err => console.log("getInterfaceStates ip link:", err))

        this.getWifiStatusSoon(100)
    }
    
    getWifiStatusSoon(ms) {
        if (!this.wifiStatusTimer)
            this.wifiStatusTimer = setTimeout(() => this.getWifiStatus(), ms)
    }

    getWifiStatus() {
        this.wifiStatusTimer = null
        this.execWpaCli(["status"])
        .then(stdout => {
            this.wifi_state = null
            let mm = stdout.match(/^wpa_state=(\S+)$/m)
            if (mm) this.wifi_state = mm[1]
            if (this.wifi_state == "COMPLETED") this.wifi_state = "CONNECTED"
            this.matron.emit("netWifiState", this.wifi_state)
            if (! ["CONNECTED","INACTIVE"].includes(this.wifi_state)) {
                this.getWifiStatusSoon(2000)
            }
        })
        .catch(err => console.log("getWiFiStatus wpa_cli:", err))
    }
    
    // set this.wifi_state and this.hotspot_state to null|"on"|"off"
    readIfaces(lines) {
        //this.wifi_state = null
        this.hotspot_state = null
        // match: 3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP mode DORMANT group default qlen 1000
        let mm = lines.match(/wlan0:.*state\s+(\S+)/)
        //if (mm && mm.length == 2) this.wifi_state = mm[1] == "UP" ? "ON" : "OFF"
        mm = lines.match(/ap0:.*\sstate\s+(\S+)/)
        if (mm && mm.length == 2) this.hotspot_state = mm[1] == "UP" ? "ON" : "OFF"
        console.log(`Interface states: wifi:${this.wifi_state} hotspot:${this.hotspot_state}`)
        //this.matron.emit("netWifiState", this.wifi_state)
        this.matron.emit("netHotspotState", this.hotspot_state)
    }
    
    // ===== wifi and hotspot control
    
    execFile(cmd, args) {
        return new Promise((resolve, reject) => {
            ChildProcess.execFile(cmd, args, (code, stdout, stderr) => {
                //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
                if (code || stderr)  reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr||code}`))
                else resolve(stdout.trim())
            })
        })
    }
    
    execWpaCli(args) { return this.execFile(WPA_CLI, ["-i", "wlan0", ...args]) }
    
    getWifiCountry() { return this.execWpaCli(["get", "country"]) }

    getWifiSSID() { return this.execWpaCli(["get_network", "wlan0", "ssid"]) }
    
    getWifiConfig() {
        Promise.all([this.getWifiCountry(), this.getWifiSSID()])
        .then(([country, ssid]) => {
            if (ssid.length > 1) ssid = ssid.substr(1, ssid.length-2)
            this.matron.emit("netWifiConfig", {country, ssid})
        })
        .catch(err => {
            console.log("getWifiConfig:", err)
            this.matron.emit("netWifiConfig", {country: "US", ssid: ""})
        })
    }

    async setWifiConfig(config) {
        // set country code if it has changed
        if (config.country) {
            console.log("Set WiFi country code:", config.country)
            try { await this.execWpaCli(["set", "country", config.country]) }
            catch(e) { console.log("setWifiConfig country:", e) }
        }
        // set ssid
        if (config.ssid) {
            console.log("Set WiFi ssid:", config.ssid)
            try { await this.execWpaCli(["set_network", "wlan0", "ssid", `"${config.ssid}"`]) }
            catch(e) { console.log("setWifiConfig ssid:", e) }
        }
        // set passphrase
        if (config.passphrase) {
            console.log("Set WiFi passphrase:", config.passphrase.length)
            try { await this.execWpaCli(["set_network", "wlan0", "psk", `"${config.passphrase}"`]) }
            catch(e) { console.log("setWifiConfig passphrase:", e) }
        } else if (config.passphrase !== undefined) {
            console.log("Set WiFi no-passphrase")
            try { await this.execWpaCli(["set_network", "wlan0", "key_mgmt", "NONE"]) }
            catch(e) { console.log("setWifiConfig passphrase:", e) }
        }
        // save and reconfigure
        try {
            await this.execWpaCli(["enable", "wlan0"])
            await this.execWpaCli(["save_config"])
            await this.execFile("/usr/bin/cat", ["/etc/wpa_supplicant/wpa_supplicant.conf"])
            await this.execWpaCli(["reconfigure"])
        } catch(e) {
            console.log("setWifiConfig:", e)
        }
        this.getWifiConfig()
        this.getWifiStatusSoon(200)
        setTimeout(() => this.getInterfaceStates(), 10000)
    }
    
    async enableWifi(enable) {
        try {
            await this.execWpaCli([enable ? "enable" : "disable", "wlan0"])
            await this.execWpaCli(["save_config"])
            await this.execWpaCli(["reconfigure"])
            this.getWifiStatusSoon(1000)
        } catch(e) {
            console.log("enableWifi:", e)
        }
    }
    
    enableHotspot(enable) {
        this.matron.emit("netHotspotState", enable ? "enabling" : "disabling")
        ChildProcess.execFile(HOTSPOT_SCRIPT, [enable ? "on" : "off"], (code, stdout, stderr) => {
            console.log(`Hotspot control script code=${code} stdout=${stdout} stderr=${stderr}`)
            // if something changes the route monitor will trigger an update, do a catch-all check:
            setTimeout(() => this.getInterfaceStates(), 10000)
        })
    }

    // ===== connectivity checks

    setInetStatus(status) {
        this.inet_status = status
        this.matron.emit("netInet", status)
    }
    setMotusStatus(status) {
        this.motus_status = status
        this.matron.emit("netMotus", status)
    }
    
    testConnectivity() {
        if (this.testing_conn) return
        this.testing_conn = true
        
        // an error occurred, the status is set, try again sometime
        const failure_recheck = () => {
            if (this.check_timer) clearTimeout(this.check_timer)
            this.check_timer = setTimeout(() => this.testConnectivity(), this.recheck_time)
            this.recheck_time = 2*this.recheck_time
            if (this.recheck_time > INET_RECHECK_MAX) this.recheck_time = INET_RECHECK_MAX
            this.testing_conn = false
        }
        
        // connectivity is good, reset the retry timer, verify at max recheck time
        const success_recheck = () => {
            if (this.check_timer) clearTimeout(this.check_timer)
            this.check_timer = setTimeout(() => this.testConnectivity(), INET_RECHECK_MAX)
            this.recheck_time = INET_RECHECK_INIT
            this.testing_conn = false
        }

        // if we don't have a default route don't bother testing
        if (!this.default_route) {
            // no default route, no point trying to reach servers
            this.setInetStatus("--")
            this.setMotusStatus("--")
            failure_recheck()
            return
        }

        // start checking the general internet connectivity
        this.testHttpRequest(URL_CONN, 204)
        .catch((err) => {
            this.setInetStatus(err)
            this.setMotusStatus("--")
            failure_recheck()
        })
        .then(() => {
            // got connectivity, now check motus
            this.setInetStatus("OK")
            this.setMotusStatus("checking")
            this.testHttpRequest(URL_MOTUS, 302) // motus should return a redirect to login
            .catch((err) => {
                this.setMotusStatus(err)
                failure_recheck()
            })
            .then(() => {
                this.setMotusStatus("OK")
                success_recheck()
            })
        })
    }

    // test an HTTP GET request, and check the status code
    // returns a promise, resolves if all OK, rejects with "err" or "timeout"
    async testHttpRequest(url, okStatus) {
        try {
            const resp = await centra(url, 'GET')
                .timeout(20*1000)
                .send()
            if (resp.statusCode == okStatus) {
                console.log(`I-Net check ${url} check: OK`)
                return "OK"
            }
            console.log(`I-Net check ${url} got code: ${resp.statusCode}`)
            return "ERR"
        } catch (e) {
            console.log(`I-Net check ${url}: ${e.message}`)
            throw e.message.match(/timeout/i) ? "TIMEOUT" : "ERR"
        }
    }
    
}

module.exports = { WifiMan }