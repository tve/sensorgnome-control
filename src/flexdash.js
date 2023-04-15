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
const OS = require('os')
const Cp = require('child_process')
const Express = require('express')
const Http = require('http')
const Morgan = require("morgan")  // request logger middleware
const Cors = require('cors')  // Cross-origin resource sharing middleware for Expressjs
const Session = require('express-session')
const FileStore = require('session-file-store')(Session)
const { Server } = require("socket.io")
//const Pam = require('authenticate-pam')
const { machineID } = require('./machine.js')

const runClient = false

// list of paths that are used by connectivity checks of mobile devices that we want to redirect
// to the dashboard so when the device connects to our hotspot the dashboard pops up
// From https://github.com/tretos53/Captive-Portal/blob/master/default_nginx
const captive = [ "/generate_204", "/gen_204", "/blank.html", "mobile/status.php", "hotspot-detect.html" ]
//const captive_ua = [ "CaptiveNetworkSupport" ] // needed for some iOS devices?
//const captive_dest = [ "connectivitycheck.gstatic.com" ] // I believe the generate_204 captures this

class FlexDash {

    constructor(theMatron) {
        this.matron = theMatron
        this.config_file = "fd-config.json"
        this.fd_config = {} // FlexDash config
        this.fd_data = {} // data tree
        this.io = null
        this.saving = false // a config save is queued
        this.app = null // Express app
        this.webserver = null // HTTP server
        this.uploads = {} // uploads in progress indexed by upload id
        this.clio = null // socket.io client
        this.monitoring = null // callback to get monitoring data
        console.log("FlexDash constructed")
    }

    start() {
        this.app = Express()
        this.app.use(Morgan('tiny', {
            skip: (req, res) => req.url.startsWith("/flexdash/assets"),
        }))
        this.app.use(Cors({credentials: true, origin: true}))
        this.app.set('trust proxy', true)
        this.session = Session({ // used for Express and Socket.io
            store: new FileStore({
                path: "/run/sg-sessions",
                retries: 1,
                ttl: 6*3600,
            }),
            name: 'sensorgnome',
            secret: 'flexdash@' + machineID,
            resave: false,
            saveUninitialized: true,
            cookie: {
                maxAge: 3600000, // 1 hour
                secure: 'auto',
                // need sameSite=none to develop using https
                //sameSite: 'none', // break non-HTTPS use, e.g. over hotspot
                sameSite: 'strict', // strict needed for HTTP to work
            },
        })
        this.app.use(this.session)
        this.webserver = Http.createServer(this.app)

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
            this.io = new Server(this.webserver, {
                path: '/fd',
                cors: { origin: true, methods: ["GET", "POST"], credentials: true },
            })
            console.log("Socketio mounted on /fd")

            // Add session support
            this.io.use((socket, next) => this.session(socket.request, {}, next))
            this.io.use((socket, next) => {
                let session = socket.request.session
                console.log("SIO auth, session ID: ", session?.id?.substr(0, 8))
                if (session?.rooms) {
                    next() // FIXME: join appropriate rooms
                } else {
                    // client is not authorized, send a message back with info on how to login
                    let err = Error('unauthorized')
                    err.data = {
                        message: 'unauthorized', realm: 'SensorGnome ' + machineID,
                        url: '/login', strategy: 'user-password',
                        user: Machine.username, fixed_user: true,
                    }
                    next(err)
                }
            })
            this.io.on('connection', this.handleConnection.bind(this))

            setInterval(() => { this.io.send('time', (new Date()).toISOString()) }, 5000)
        })

        // mount static content, publicly accessible
        this.app.get('/', (...args) => this.sendIndexHtml(...args))
        this.app.post('/login', Express.json(), (req, res) => this.login(req, res))
        this.app.get('/monitoring', (req, res) => this.sendMonitoring(req, res))
        this.app.use(Express.static(__dirname + '/public', { extensions: ['html'] }))

        // mount redirects for captive portal
        for (const c of captive) {
            this.app.get(c, (_, res) => res.redirect('http://192.168.7.2/')) // FIXME: https
        }
        
        // add auth middleware, this means everything added later requires auth
        this.app.use((req, res, next) => {
            let session = req.session
            console.log("HTTP auth, session ID: ", session?.id)
            if (session?.rooms) {
                next()
            } else {
                // client is not authorized, return 401 (ain't got no login page...)
                res.status(401).end()
            }
        })

        // start web server
        this.webserver.requestTimeout = 60 * 1000 // for the initial request
        this.webserver.timeout = 300 * 1000 // inactivity timeout
        this.webserver.listen(8080, 'localhost', () => {
            console.log("SensorGnome FlexDash listening on port %d in %s mode",
                this.webserver.address().port, this.app.settings.env)
        })

        // if (runClient) this.startClient()
    }

    // // start the socket.io client that connects to a Sensorgnome hub (central management server)
    // startClient() {
    //     this.clio = SIOClient.io()
    //     const opts = { path: '/sg' }
    //     const url = `http://192.168.0.2:8080/?sg=${machineID}`
    //     this.clisock = this.clio(url, opts)

    //     this.clisock.on('disconnect', () => {
    //         this.clisock = null
    //     })
    //     this.clisock.on('connect', () => {
    //         console.log("Connected to Sensorgnome Hub")
    //         this.sendData(this.clisock)
    //     })
    // }

    // send top-level '/' in the form of a patched public/flexdash.html with title/name patched
    sendIndexHtml(req, res) {
        Fs.readFile(__dirname+'/public/flexdash.html', (err, data) => {
            if (err) {
                console.log("Error loading flexdash.html: ", err)
                res.status(500).end()
                return
            }

            data = data.toString()
                .replace(/title:.*/, `title: '${Machine.machineID}',`)
                .replace(/<title>[^<]+/, `<title>${Machine.machineID}`)
            res.end(data)
        })
    }

    // send monitoring metrics (json format)
    sendMonitoring(req, res) {
        const data = this.monitoring?.() || {}
        res.json(data)
    }
    
    registerGetHandler(path, handler) {
        this.app.get(path, handler) // FIXME: need authentication
    }

    set(path, value) {
        try {
            let pp = path.split('/')
            let p = pp.pop()
            let node = this.walkTree(this.fd_data, pp)
            node[p] = value
            if (this.io) {
                // set may be called before start so can't emit, data will be sent on connection
                //if (path.startsWith('lotek')) console.log("SET", path, value)
                this.io.emit('set', path, value)
            }
            //if (path != 'tag' && !path.startsWith('detection')) console.log(`SIO set data ${path}`)
        } catch (err) {
            console.log(`FD: Internal error setting ${path}: ${err}`)
        }
    }

    // get is used by the monitoring handler to extract info (not pretty, but it works...)
    get(path) {
        let pp = path.split('/')
        let p = pp.pop()
        let node = this.walkTree(this.fd_data, pp)
        return node[p]
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
        const ss = socket.request.session
        console.log(`SIO connection ${socket.id} session=${ss.id.substring(0,8)} x-domain:${hs.xdomain}`)
        this.sendData(socket)

        // handle incoming messages
        socket.on("msg", (topic, payload) => {
            try {
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
            } catch(err) {
                console.log("Exception handing sio message:", err)
            }
        })

        socket.on("req", (id, topic, payload) => {
            try {
                if (typeof topic !== 'string') {
                    console.warn(`SIO request doesn't have string topic: ${JSON.stringify(topic)}`)
                } else {
                    console.log(`SIO request ${socket.id} id=${id} topic=${topic} payload=${payload}`)
                    this.matron.emit("dash_" + topic, payload, (resp) => {
                        socket.emit("resp", id, resp)
                    })
                }
            } catch(err) {
                console.log("Exception handing sio message:", err)
            }
        })

        // upload start request
        socket.on("upstart", (id, topic, payload) => {
            try {
                if (typeof topic !== 'string') {
                    console.warn(`SIO upstart doesn't have string topic: ${JSON.stringify(topic)}`)
                } else {
                    console.log(`SIO upstart ${socket.id} id=${id} topic=${topic} payload=${payload}`)
                    this.doUpload(socket, id, topic, payload)
                }
            } catch(err) {
                console.log("Exception handing sio message:", err)
            }
        })

        // upload continue message
        socket.on("upcont", (topic, payload) => {
            try {
                if (typeof topic !== 'string') {
                    console.warn(`SIO upcont doesn't have string topic: ${JSON.stringify(topic)}`)
                } else {
                    console.log(`SIO upcont ${socket.id} id=${id} topic=${topic} payload=${payload}`)
                    this.doUpload(null, topic, payload)
                }
            } catch(err) {
                console.log("Exception handing sio message:", err)
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
            if (k == "conn") continue // don't overwrite connection info
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
                Fs.writeFile(this.config_file, JSON.stringify(this.fd_config, null, 2), (err) => {
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

    // extract the password field from /etc/shadow for the specific user
    shadow_hash(user, cb) {
        Fs.readFile("/etc/shadow", (err, data) => {
            if (err) return cb(err)
            const lines = data.toString().split('\n')
            const line = lines.find(l => l.startsWith(`${user}:`))
            if (!line) return cb(`User '${user}' does not exist`)
            const fields = line.split(':')
            if (fields.length < 2) return cb(`User '${user}' has no password`)
            const hash = fields[1]
            if (hash == '*') return cb(`User '${user}' has no password`)
            cb(null, hash)
        })
    }

    // use python's crypt function to verify the password,
    // see https://www.baeldung.com/linux/shadow-passwords
    py_auth(user, pass, cb) {
        this.shadow_hash(user, (err, verifier) => {
            if (err) return cb(err)
            const method_salt = verifier.replace(/\$[^$]+$/, '$')
            const args = ["-c", `import crypt; print(crypt.crypt("${pass}", "${method_salt}"))`]
            Cp.execFile("/usr/bin/python3", args, (err, stdout, stderr) => {
                if (err) return cb(err)
                if (stdout.trim() != verifier) return cb(`Wrong password for user '${user}'`)
                return cb(null)
            })
        })
    }

    login(req, res) {
        console.log(`SIO login, user=${req.body?.user} pass-len=${req.body?.password?.length}`)
        if (req.body) {
            //Pam.authenticate(req.body?.user, req.body?.password, (err) => {
            this.py_auth(req.body?.user, req.body?.password, (err) => {
                if (err) {
                    console.log("Login failed: ", err)
                    delete req.session.rooms
                    res.status(401).end()
                } else {
                    req.session.rooms = "*"
                    res.status(200).end()
                    this.matron.emit("dash_login", req.body?.user, req.body?.password)
                }
            }, {serviceName: 'login', remoteHost: 'localhost'})
        } else {
            delete req.session.rooms
            res.status(401).end()
        }
    }

    // doUpload moves a file upload along (i.e. upload from FlexDash to us).
    // There are three phases to an upload:
    // - The first message contains the info (name, size, etc.) and a first chunk of data.
    //   Before processing the data an application handler is called to validate the info and
    //   return a filename or rejection. If the response is to proceed then the data is saved to
    //   a temp file.
    // - Subsequent messages have data that is appended to the temp file.
    // - The last message has data that is also appended, the temp file is renamed to its final
    //   destination, and the application handler is notified that the upload is complete.
    // - Note that in the case of a small upload all this happens for one message and the
    //   handler is called twice.
    doUpload(socket, req_id, topic, payload) {
        if (!(typeof payload == 'object' && payload.name && typeof payload.size === 'number' &&
              typeof payload.id === 'number' && 'offset' in payload)) {
            console.log("dashboard: malformatted upload payload")
            if (req_id !== null) socket.emit("resp", req_id, false)
            return
        }

        let self = this

        function do_last(info) {
            // end of file, close and rename
            Fs.closeSync(info.fd)
            Fs.renameSync(info.tmp_name, info.tgt_name)
            // notify app
            delete payload.data
            self.matron.emit("dash_" + topic, "done", payload)
            console.log("flexdash: upload complete: " + info.tgt_name)
            delete self.uploads[payload.id]
        }

        // dispatch first request to application to get filename/reject
        if (req_id !== null) {
            let data = payload.data
            delete payload.data // don't pass payload to handler to avoid mistakes there
            this.matron.emit("dash_" + topic, "begin", payload, (resp) => {
                if (resp && typeof resp === 'string') {
                    // start writing to file, this stuff should be async...
                    payload.tmp_name = OS.tmpdir() + "/fd-upload-" + Math.trunc(Math.random()*1E9)
                    payload.tgt_name = resp
                    payload.fd = Fs.openSync(payload.tmp_name, 'wx', 0o600)
                    Fs.writeSync(payload.fd, data)
                    if (payload.last) do_last(payload)
                    else this.uploads[payload.id] = payload
                }
                // send response back
                socket.emit("resp", req_id, resp)
            })
        // append subsequent messages to file and handle last message
        } else if (this.uploads[payload.id]) {
            let info = this.uploads[payload.id]
            Fs.writeSync(info.fd, payload.data) // FIXME: make async
            if (payload.last) do_last(info)
        } else {
            console.log("flexdash: got data for unknown upload")
        }
    }

}

module.exports = FlexDash
