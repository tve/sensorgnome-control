const { WifiMan } = require('wifiman.js')

describe('WifiMan', () => {
    let wm
    let matron
    let emits = []
  
    beforeEach(() => {
        matron = {
            on: jest.fn((topic, fun) => { m_on[topic] = fun}),
            //emit: jest.fn((topic, ...args) => { if (topic in m_on) m_on[topic](...args) }),
            emit: jest.fn((topic, ...args) => { emits.push([topic, ...args]) }),
        }
        emits = []
        wm = new WifiMan(matron)
    })

    describe('readRoute', () => {
        it('reads a route with device', () => {
            wm.readRoute("1.1.1.1 via 192.168.0.25 dev wlan0 src 192.168.0.93 uid 1000\ncache\n")
            expect(wm.default_route).toBe("wifi")
            expect(emits[0][0]).toEqual("netDefaultRoute")
            expect(emits[0][1]).toEqual("wifi")
        })

        it('reads a route with unknown device', () => {
            wm.readRoute("1.1.1.1 via 192.168.0.25 dev ap0 src 192.168.0.93 uid 1000\ncache\n")
            expect(wm.default_route).toBe("ap0")
            expect(emits[0][0]).toEqual("netDefaultRoute")
            expect(emits[0][1]).toEqual("ap0")
        })

        it('reads a route without device', () => {
            wm.readRoute("1.1.1.1 via 192.168.0.25\ncache\n")
            expect(wm.default_route).toBe("other")
            expect(emits[0][0]).toEqual("netDefaultRoute")
            expect(emits[0][1]).toEqual("other")
        })

        it('handles not having a route', () => {
            wm.readRoute("RTNETLINK answers: Network is unreachable\n")
            expect(wm.default_route).toBeNull()
            expect(emits[0][0]).toEqual("netDefaultRoute")
            expect(emits[0][1]).toEqual("none")
        })
    })

    describe('readIfaces', () => {
        it('reads the wifi interface state', () => {
            wm.readIfaces(
`    link/ether e4:5f:01:67:45:3f brd ff:ff:ff:ff:ff:ff
3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP mode DORMANT group default qlen 1000
     link/ether e4:5f:01:67:45:41 brd ff:ff:ff:ff:ff:ff`)
            expect(wm.wifi_state).toBe("ON")
            expect(emits[0]).toEqual(["netWifiState", "ON"])
            expect(emits[1]).toEqual(["netHotspotState", null])
        })

        it('reads the wifi and hotspot interface states', () => {
            wm.readIfaces(
`4: ap0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc pfifo_fast state DOWN mode DEFAULT group default qlen 1000
    link/ether e4:5f:01:67:45:3f brd ff:ff:ff:ff:ff:ff
3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP mode DORMANT group default qlen 1000
     link/ether e4:5f:01:67:45:41 brd ff:ff:ff:ff:ff:ff`)
            expect(wm.wifi_state).toBe("ON")
            expect(emits[0]).toEqual(["netWifiState", "ON"])
            expect(emits[1]).toEqual(["netHotspotState", "OFF"])
        })

    })

    describe('read_wifi_config', () => {
        it('parses wifi config with quotes', () => {
            const config = `# Sensorgnome Wifi Client configuration file
                WIFI_ENABLE=no
                WIFI_SSID="my ssid"
                WIFI_PASSPHRASE="my pass"
                WIFI_COUNTRY=zy # ISO country code: US,CA,DE,FR,GB,MX,PE,...
                `
            const wconf = wm.parseWifiConfig(config)
            expect(wconf).toEqual({enable: false, ssid: "my ssid", passphrase: "my pass", country: "zy"})
        })

        it('parses wifi config without quotes', () => {
            const config = `# Sensorgnome Wifi Client configuration file
                WIFI_ENABLE=1
                WIFI_SSID=myssid
                WIFI_PASSPHRASE=mypass
                WIFI_COUNTRY=AB # ISO country code: US,CA,DE,FR,GB,MX,PE,...
                `
            const wconf = wm.parseWifiConfig(config)
            expect(wconf).toEqual({enable: true, ssid: "myssid", passphrase: "mypass", country: "AB"})
        })

        it('handles bad config', () => {
            const config = `XXX`
            const wconf = wm.parseWifiConfig(config)
            expect(wconf).toEqual({enable: false, ssid: "", passphrase: "", country: "US"})
        })

    })

})
