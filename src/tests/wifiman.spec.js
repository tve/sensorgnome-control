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


})
