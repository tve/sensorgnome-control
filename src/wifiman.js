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

const centra = require("./centra.js")

const IP_CMD = "/usr/sbin/ip"
const route_map = { wlan0: "wifi", eth0: "eth", usb: "cell" }

const URL_CONN = 'http://connectivitycheck.gstatic.com/generate_204' // Android connectivity check
const URL_MOTUS = 'https://www.motus.org/data' // Motus connectivity check
const INET_RECHECK_INIT = 10000
const INET_RECHECK_MAX = 3600 * 1000


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
    }

    start() {
        this.launchRouteMonitor()
        setTimeout(() => this.getDefaultRoute(), 3000)
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
            setTimeout(() => this.test_connectivity(), 1000)
        })
    }
    
    // set this.default_route to null|"wifi"|"ethernet"|"cell"|"other"
    readRoute(lines) {
        let route = null
        for (let line of lines.split("\n")) {
            let mm = line.match(/^1.1.1.1\s+via\s+(\S+)(\s+dev\s+(\S+))?/)
            if (mm && mm.length == 4) {
                route = mm[3] || "other"
                console.log(`Default route: ${route} (${line})`)
            }
        }
        // map device names to "english"
        if (route && route_map[route]) route = route_map[route]
        // publish
        console.log("Default route:", route)
        this.default_route = route
        this.matron.emit("netDefaultRoute", route || "none")
    }

    // ===== connectivity checks

    set_inet_status(status) {
        this.inet_status = status
        this.matron.emit("netInet", status)
    }
    set_motus_status(status) {
        this.motus_status = status
        this.matron.emit("netMotus", status)
    }

    test_connectivity() {
        if (this.testing_conn) return
        if (!this.default_route) {
            // no default route, no point trying to reach servers
            this.set_inet_status("--")
            this.set_motus_status("--")
        }
        this.testing_conn = true

        // an error occurred, the status is set, try again sometime
        const failure_recheck = () => {
            setTimeout(() => this.test_connectivity(), this.recheck_time)
            this.recheck_time = 2*this.recheck_time
            if (this.recheck_time > INET_RECHECK_MAX) this.recheck_time = INET_RECHECK_MAX
            this.testing_conn = false
        }

        // connectivity is good, reset the retry timer, verify at max recheck time
        const success_recheck = () => {
            setTimeout(() => this.test_connectivity(), INET_RECHECK_MAX)
            this.recheck_time = INET_RECHECK_INIT
            this.testing_conn = false
        }

        // start checking the general internet connectivity
        this.test_http_request(URL_CONN, 204)
        .catch((err) => {
            this.set_inet_status(err)
            this.set_motus_status("--")
            failure_recheck()
        })
        .then(() => {
            // got connectivity, now check motus
            this.set_inet_status("OK")
            this.set_motus_status("checking")
            this.test_http_request(URL_MOTUS, 302) // motus should return a redirect to login
            .catch((err) => {
                this.set_motus_status(err)
                failure_recheck()
            })
            .then(() => {
                this.set_motus_status("OK")
                success_recheck()
            })
        })
    }

    // test an HTTP GET request, and check the status code
    // returns a promise, resolves if all OK, rejects with "err" or "timeout"
    async test_http_request(url, okStatus) {
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
