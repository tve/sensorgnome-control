// Socket.io server for FlexDash
// Copyright ©2021 Thorsten von Eicken

// The FlexDash class contains the low-level functions to communicate with the FlexDash
// dashboard over socket.io. It deals with sending the dashboard configuration and saving
// any changes made to a file. It provides functions to broadcast data to all connected
// dashboards.

// Notes:
// File upload/download should probably be handled using
// https://stackoverflow.com/questions/29066117 for download and
// https://github.com/sffc/socketio-file-upload for upload.

// Temporary Express instance
// const express = require('express')
// const Morgan = require("morgan")  // request logger middleware
// const Proxy = require('express-http-proxy') // proxy middleware
// const app = express()
// app.use(Morgan('tiny'))
// const http = require('http')
// const webserver = http.createServer(app)

const Fs = require('fs')
const { Server } = require("socket.io")
const Proxy = require('express-http-proxy') // proxy middleware

const FD_VERSION = '0.2.4'

class FlexDash {

    constructor(theMatron) {
        this.matron = theMatron
        this.config_file = "fd-config.json"
        this.fd_config = {} // FlexDash config
        this.fd_data = {} // data tree
        this.io = null
        this.saving = false; // a config save is queued
        console.log("FlexDash constructed")
    }

    start(webserver) {
        this.app = webserver.app

        // load config from file
        Fs.readFile(this.config_file, (err, data) => {
            if (err) {
                console.log("Error loading FlexDash config: ", err)
            } else {
                try {
                    this.fd_config = JSON.parse(data)
                    console.log("Loaded FlexDash config from", this.config_file)
                } catch (err) {
                    console.log("Error parsing FlexDash config:", err)
                }
            }

            // Init Socket.io
            this.io = new Server(webserver.server, {
                path: '/fd',
                cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
            })
            console.log("Socketio mounted on /fd")

            this.load_static_data()

            this.io.on('connection', this.handleConnection.bind(this))

            setInterval(() => { this.io.send('time', (new Date()).toISOString()) }, 5000)
        })
    }
    
    registerGetHandler(path, handler) {
        this.app.get(path, handler)
    }

    load_static_data() {
        let uptime = parseInt(Fs.readFileSync("/proc/uptime").toString(), 10)
        if (uptime < 120) uptime = `${uptime} seconds`
        else if (uptime < 2 * 60) uptime = `${Math.round(uptime / 60)} minutes`
        else if (uptime < 2 * 60 * 60) uptime = `${Math.round(uptime / 3600)} hours`
        else uptime = `${Math.round(uptime / 3600 / 24)} days`

        this.set('machineinfo', { ...Machine, uptime })
    }

    set(path, value) {
        try {
            let pp = path.split('/')
            let p = pp.pop()
            let node = this.walkTree(this.fd_data, pp)
            node[p] = value
            if (this.io) {
                // set may be called before start so can't emit, data will be sent on connection
                //if (path.startsWith('detections_hou')) console.log("SET", path, value)
                this.io.emit('set', path, value)
            }
            if (path != 'tag' && path != 'detections_5min') console.log(`SIO set data ${path}`)
        } catch (err) {
            console.log(`FD: Internal error setting ${path}: ${err}`)
        }
    }

    unset(path) {
        try {
            let pp = path.split('/')
            let p = pp.pop()
            let node = this.walkTree(this.fd_data, pp)
            if (Array.isArray(node)) node.splice(p, 1)
            else delete node[p]
            if (this.io) {
                // set may be called before start so can't emit, data will be sent on connection
                this.io.emit('unset', path)
            }
            console.log(`SIO unset data ${path}`)
        } catch (err) {
            console.log(`FD: Internal error unsetting ${path}: ${err}`)
        }
    }

    // Download sends one dashboard a message instructing it to download a file. Typically this
    // is in response to some "download" button press message.
    // The dashboard targeted by the socket will request the specified url and propose the
    // specified filename as target to the user in a standard download dialog or use the filename
    // as-is within the user's download folder depending on the browser settings.
    download(socket, url, filename) {
        socket.emit('download', url, filename)
    }

    // FlexDash connected, hook handlers to save config and send initial config        
    handleConnection(socket) {
        const hs = socket.handshake
        console.log(`SIO connection ${socket.id} url=${hs.url} x-domain:${hs.xdomain}`)
        this.sendData(socket)

        // handle incoming messages
        socket.on("msg", (topic, payload) => {
            if (typeof topic !== 'string') {
                console.warn(`SIO message doesn't have string topic: ${JSON.stringify(topic)}`)
            } else if (topic === "$ctrl" && payload === "start") {
                this.sendConfig(socket)
            } else if (topic.startsWith("$config")) {
                this.saveConfig(socket, topic, payload)
            } else {
                console.log(`SIO message ${socket.id} topic=${topic} payload=${payload}`)
                this.matron.emit("dash_" + topic, payload, socket)
            }
        })

        // handle disconnection
        socket.on("disconnect", reason => {
            console.log(`SIO disconnected ${socket.id} due to ${reason}`)
        })
    }

    // Send dashboard configuration to FD
    sendConfig(socket) {
        console.log(`SIO send config ${socket.id}`)
        let keys = Object.keys(this.fd_config)
        // handle empty config
        if (keys.length == 0) {
            console.log('Sending empty config')
            socket.emit("set", "$config", {})
            return
        }
        // FD wants each top-level key in its own message
        for (let k of Object.keys(this.fd_config)) {
            socket.emit("set", "$config/" + k, this.fd_config[k])
        }
    }

    // Send dashboard data to FD
    sendData(socket) {
        console.log(`SIO send data ${socket.id}`) // ` ${JSON.stringify(this.fd_data)}`)
        for (let k of Object.keys(this.fd_data)) {
            socket.emit("set", k, this.fd_data[k])
        }
    }

    // Save dashboard configuration as received from FD
    saveConfig(socket, topic, payload) {
        console.log(`SIO save config ${socket.id} topic=${topic}`) // payload=${JSON.stringify(payload)}`)
        
        // insert the payload into the saved config, the topic must be either something
        // like $config/widgets or like $config/widgets/w00002
        const t = topic.split('/')
        if (t.length == 2) {
            this.fd_config[t[1]] = payload
        } else if (t.length == 3) {
            // sub-key, need to merge (or delete) data
            let value = this.fd_config[t[1]] || {}
            if (payload === undefined || payload == null) {
                delete value[t[2]]
            } else {
                value[t[2]] = payload
            }
            this.fd_config[t[1]] = value
        }
        
        // propagate the change to all connected FD clients
        socket.broadcast.emit("set", topic, payload) // sends to all but socket
        
        // save to file
        if (!this.saving) {
            setTimeout(() => {
                console.log(`SIO write config`)
                Fs.writeFile(this.config_file, JSON.stringify(this.fd_config), (err) => {
                    if (err) {
                        console.log("ERROR: failed to save FlexDash config: ", err)
                    }
                })
                this.saving = false
            }, 1000)
            this.saving = true
        }
    }

    // walkTree takes the root of an object hierarchy and a path array, then walks
    // down the tree along the path and returns the final node in the tree.
    walkTree(root, path) {
        let node = root
        for (const d of path) {
            // handle empty path element (e.g. consecutive slashes)
            if (d == '') {
                // do nothing
                // handle traversing an array, need to parse index into an int
            } else if (Array.isArray(node)) {
                const ix = parseInt(d, 10)
                if (Number.isNaN(ix)) {
                    throw `Array index '${d}' in '${path}' is not an int`
                } else if (ix < 0 || ix >= node.length) {
                    throw `Array index '${d}' in '${path}' > ${node.length}`
                }
                node = node[ix]
            } else if (typeof node === 'object') {
                // need to handle undefined here because we explicitly set properties to undefined if
                // we need to attach a watcher to a property that doesn't exist FIXME: outdated?
                if (!(d in node) || typeof node[d] === 'undefined')
                    node[d] = {} // allow new subtrees to be created
                node = node[d]
            } else {
                throw `Level '${d}' of '${path}'' is not traversable: ${typeof node[d]}`
            }
        }
        return node
    }

}

module.exports = FlexDash
