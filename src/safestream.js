/*
  safestream.js : safe writable stream on a disk, which writes in text. After an hour, or a
  specified number of bytes, or if there is a clock step it starts a new file and
  compresses the previous one to .txt.gz.

  In principle a SafeStream is agnostic to its contents/format, but we do want to keep track of
  some stats, like the number of data records written, at least for the data files, which is 100%
  of SafeStream's usage. So the `parse` flag to the constructor enables parsing of what gets
  written, assuming it's a line-record format. Ugly violation of abstraction levels but simple.

  Note: the original version wrote simultaneously to .txt and .txt.gz and deleted the .txt
  on closing. The purpose of the txt was for recovery if the process crashes or the system
  runs out of power (not uncommon on solar), but it ends up leaving a bunch of .txt files
  that complicate anything downstream that touches any files.
  Writing to txt and then running gzip to compress makes everything simpler, the only downside
  is that when the SDcard is full the gz may fail, so there would be an uncompressed txt file left.
  In the days of 32GB SDcards for $10 that should be a rare occurrence...
*/

class SafeStream {
    constructor (matron, source, ext, chunkbytes, chunksecs, parse) {
        // source will usually be "all", and extension will usually be ".txt"

        this.matron = matron
        this.source = source
        this.ext = ext
        this.chunksecs = chunksecs
        this.chunkbytes = chunkbytes
        this.lastData = null
        this.parse = parse
        this.setupStreams()
        matron.on("gpsSetClock", () => this.gpsSetClock())
    }
    
    setupStreams () {
        let path = DataSaver.getRelPath(this.source)
        this.tscode = Chrony.timeStampCode() // time-stamp precision used by DataSaver (yuck)
        this.sout = DataSaver.getStream(path, this.ext)
        this.sout.stream.on("error", (e) => this.streamError(e))
        this.bytesWritten = 0
        this.info = this.parse && { data_lines:0, first_data: null, last_data: null, gps: false }
        if (this.chunkTimer) clearTimeout(this.chunkTimer)
        this.chunkTimer = setTimeout(() => {
            this.end()
            this.setupStreams()  
        }, this.chunksecs * 1000)
    }

    write (data) {
        this.lastData = data
        this.sout.stream.write(data)
        this.bytesWritten += data.length
        if (this.bytesWritten >= this.chunkbytes) {
            this.end()
            this.setupStreams()
        }
        if (this.info) {
            // keep track of some stats, we assume each write() is for one or multiple complete lines
            for (const line in data.toString().split("\n")) {
                if (line.startsWith("G")) {
                    this.info.gps = true
                } else if (line.startsWith("T") || line.startsWith("p")) {
                    data_lines++
                    const fields = line.split(",")
                    const ts = parseFloat(fields[1])
                    if (first_data === null) first_data = ts
                    last_data = ts
                }
            }
        }
    }

    end () {
        if (this.chunkTimer) clearTimeout(this.chunkTimer)
        if (this.sout.stream) {
            this.sout.stream.end()
            this.sout.stream = null
            // compress the just-written file, but wait a slight amount so the writer can
            // start a fresh file first
            const path = this.sout.path // capture before it gets overwritten
            const ev = this.info && { size: this.bytesWritten, ...this.info}
            setTimeout(() => {
                // the gzip process is a bit of a fire-and-forget: if it fails the uncompressed
                // file will still be there
                console.log(`SafeStream: gzipping ${path}`)
                ChildProcess.execFile("/usr/bin/gzip", [path], (err, stdout, stderr) => {
                    if (err) {
                        console.log(`SafeStream: ${err}`)
                        // emit event that uncompressed file is ready
                        if (ev) this.matron.emit("datafile", path, ev)
                    } else {
                        // emit event that compressed file is ready
                        console.log(`SafeStream: ev ${JSON.stringify(ev)}`)
                        if (ev) this.matron.emit("datafile", path+".gz", ev)
                    }
                    if (stderr) console.log(stderr)
                })
            }, 100)
        }
    }

    streamError (e) {
        console.log("SafeStream: stream error: " + e)
        this.end()
        this.setupStreams()
        // retry writing last data this may lead to some
        // of lastData being written to two different files
        if (this.lastData)
            this.write(this.lastData)
    }

    // gpsSetClock events may signal that the clock precision has changed, we start a fresh file
    // if it switches to/from "P", which is "unsynchronized", this because the date with 'P' may be
    // bogus and may have to be manually corrected later
    gpsSetClock (d) {
        let tscode = Chrony.timeStampCode()
        if ((tscode == "P") != (this.tscode == "P")) {
            console.log(`SafeStream: tscode changed from ${this.tscode} to ${tscode}`)
            this.end()
            this.setupStreams()
        }
    }
}

exports.SafeStream = SafeStream
