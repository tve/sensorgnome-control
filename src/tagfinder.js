/*
  tagfinder.js: manage a tagfinder child process, sending it vahData and setParam messages, then
  emitting gotTag messages.
*/

class TagFinder {
    constructor(matron, prog, tagFiles, params) {
        this.matron             = matron
        this.prog               = prog
        this.tagFiles           = tagFiles
        this.params             = params || []
        this.tagDBFile          = null
        this.noTagFile          = false // used to print no-tag-file error once
        this.child              = null
        this.quitting           = false

        matron.on("quit", () => this.quit())
        matron.on("vahData", x => this.gotInput(x))
        matron.on("setParam", x => this.gotParamInput(x))
        matron.on("tagDBChg", x => this.restart())
    }

    pubTagInfo(file, info) {
        console.log(`Tag Database ${file}: ${info}`)
        this.matron.emit('tagDBInfo', {file, info})
    }
    
    start() {
        if (this.quitting) return
        if (this.child) return
    
        // see whether we can find a tag file
        this.tagDBFile = null
        this.tagDBInfo = {}
        for (let tf of this.tagFiles) {
            if (Fs.existsSync(tf)) {
                this.tagDBFile = tf
                break
            }
        }

        // if we have no tag file, print an error once, and then sleep for a bit and retry
        if (! this.tagDBFile) {
            if (! this.noTagFile) {
                let info = `No tag database for tag finder, looking at ` + this.tagFiles.join(", ")
                this.pubTagInfo('-none-', info)
                this.noTagFile = true
            }
    
            setTimeout(()=>this.start(), 10000)
            return
        }
        this.noTagFile = false

        // publish info about the tag DB
        const sql_tagcnt = 'select proj, count(*) from tags group by proj order by proj'
        ChildProcess.execFile('/usr/bin/sqlite3', [this.tagDBFile, sql_tagcnt], (code, stdout, stderr) => {
            if (code || stderr) {
                this.pubTagInfo(this.tagDBFile, `Error accessing ${this.tagDBFile}: ${stderr||code}`)
            } else {
                this.pubTagInfo(this.tagDBFile, stdout.replace(/\|/g, ": ").replace(/\n/g, " tags\n"))
            }
        })

        // publish the frequency to the dashboard
        const f = this.params.indexOf('--default-freq')
        if (f >= 0) this.matron.emit("lotekFreq", this.params[f+1].toFixed(3))
        console.log("Lotek freq f=" + f + " params=" + this.params)
    
        // launch the tag finder process
        const p = this.params.concat("-c", "8", this.tagDBFile)
        console.log("Starting", this.prog, p.join(" "))
        this.child = ChildProcess.spawn(this.prog, p)
            .on("exit", ()=>this.childDied())
            .on("error", ()=>this.childDied())
    
        this.child.stdout.on("data", x => {
            for (let line of x.toString().split('\n')) {
                if (!(/^[0-9]/.test(line))) continue
                this.matron.emit("gotTag", line)
                line = 'L' + line
                console.log(`Lotek tag: ${line}`)
            }
        })
    }

    restart() {
        console.log("Restarting tag finder")
        if (this.child) {
            this.child.kill("SIGKILL") // childDied() will restart it...
        } else {
            this.start()
        }
    }

    childDied(code, signal) {
        this.child = null
        if (!this.quitting) {
            setTimeout(() => this.start(), 5000)
            console.log("Tag finder died, restarting in 5 secs")
        }
    }

    quit() {
        if (!this.child) return
        this.quitting = true
        this.child.kill("SIGKILL")
    }    

    gotInput(x) {
        if (!this.child) return
        try {
            this.child.stdin.write(x + '\n')
        } catch(e) {}
    }

    gotParamInput(s) {
        if (!this.child) return
        if (s.par != '-m') return
        try {
            this.child.stdin.write("S," + s.time + "," + s.port + "," + s.par + "," + s.val + "," + s.errCode + "," + s.err + "\n")
        } catch(e) {}
    }

}

exports.TagFinder = TagFinder
