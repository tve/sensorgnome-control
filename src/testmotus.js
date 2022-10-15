let motus_up=require("motus_up")
let process = require('process')
Machine = require('./machine.js')

Events = require('events')
Util = require("util")
let Matron = require('./matron.js')
let TheMatron = new Matron.Matron()
FlexDash = { set() {} }

async function sleep(time) { return new Promise(resolve => setTimeout(resolve, time)) }

async function doit() {
    let mup = new motus_up.MotusUploader(TheMatron)
    try {
        // start by getting a session
        let session = await mup.getSession()
        console.log("session: ", JSON.stringify(session))
        mup.session = session
        // verify the session we just got
        let verify = await mup.checkSession()
        // zap the JSESSION and make it refresh
        console.log("=== force refresh")
        mup.session = mup.session.replace(/JSESSIONID=[^;]+/, "JSESSIONID=1234567890")
        await sleep(2000)
        verify = await mup.checkSession()
        // try to reuse the old session
        console.log("=== reuse old session")
        mup.session = session
        verify = await mup.checkSession()
        // refresh the old session again
        mup.session = mup.session.replace(/JSESSIONID=[^;]+/, "JSESSIONID=1234567890")
        verify = await mup.checkSession()

    } catch(e) { console.log(e.message); process.exit(1) }
}
doit().then(()=>{console.log("DONE");process.exit(0)})

// Observations:
// GET /data can be used to check whether a set of cookies still works
// GET /data/login with just the session_token returns a new session token and a new JSESSIONID
// when refreshed like that the old session_token is invalidated, but the old JSESSIONID
// still works
// JSESSIONID times out in less than an hour
// session_token times out in 45 days
// so far it's not possible to "fork" a session_token to two new session_tokens
