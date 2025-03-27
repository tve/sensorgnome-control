// burstfinder: manage a burstfinder.py child process, sending it vahData messages, then
//  emitting gotBurst messages.

const fs = require('fs')
const Stream = require('stream');

class BurstFinder {
    constructor(matron, prog) {
        this.matron             = matron
        this.prog               = prog
        this.child              = null
        this.quitting           = false

        matron.on("quit", () => this.quit())
        matron.on("vahData", x => this.gotInput(x))

        this.CMD_PATH = "/usr/bin/python3"
        this.BY = "/run/bursts.yaml"
        this.CMD_ARGS = [ this.prog + "/burstfinder.py", "--codes", this.BY ] // stdin->stdout is default
    }

    start() {
        if (this.quitting) return
        if (this.child) return
    
        // launch the burst finder python process
        console.log("Starting", this.CMD_PATH, this.CMD_ARGS.join(' '))
        const bb = Object.entries(PulseFilter.bursts).map(([k,v]) => {
            return `${k}: [${v.map(v=>v/10.0).join(',')}]\n`
        }).join('')
        fs.writeFileSync(this.BY, bb)
        let byExists = true
        this.child = ChildProcess.spawn(this.CMD_PATH, this.CMD_ARGS)
            .on("exit", ()=>this.childDied())
            .on("error", ()=>this.childDied())

        this.child.stdout.on("data", x => {
            // console.log("From tagfinder:", x.toString());
            for (let line of x.toString().split('\n')) {
                if (!(/^[0-9]/.test(line))) continue
                this.matron.emit("gotBurst", "b"+line)
                this.matron.emit("bfOut", "b"+line)
                // line = 'L' + line
                // console.log(`Lotek tag: ${line}`)
            }
        })
        this.child.stdout.on("error", x => {})
        
        this.child.stderr.on("data", x => {
            if (byExists) { fs.unlink(this.BY, ()=>{}); byExists = false; }
            for (let line of x.toString().split('\n')) {
                if (line.trim()) console.log("Burstfinder.py:", line)
            }
        })
        this.child.stderr.on("error", x => {})
    }

    restart() {
        console.log("Restarting burstfinder.py")
        if (this.child) {
            this.child.kill("SIGKILL") // childDied() will restart it...
        } else {
            this.start()
        }
    }

    childDied(code, signal) {
        this.child = null
        fs.unlink(this.BY, ()=>{})
        if (!this.quitting) {
            setTimeout(() => this.start(), 5000)
            console.log("burstfinder.py died, restarting in 5 secs")
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
        } catch(e) {
            console.log("Error writing to burstfinder.py:", e)
        }
    }

}

exports.BurstFinder = BurstFinder
