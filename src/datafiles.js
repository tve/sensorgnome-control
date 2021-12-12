// datafiles - keep track of data files and whether they've been uploaded or downloaded
// also delete uploaded/downlaoded files if disk space is running very low
// Copyright ©2021 Thorsten von Eicken

// The DataSaver singleton creates files on one of the mounted media, specifically,
// on the first one that has space. This singleton "runs behind" and keeps track of what
// happens to the files over time using a simple JSON file that records uploads (to a server
// via the internet) and downloads (to a laptop/phone via the web UI).
//
// It also keeps some stats about each of the files so that the UI can display them.

// Duplicate files: in general the system does not produce duplicate files, but accidents
// can happen. The DataFiles code does not try to guard against duplicates, they will simply
// be there twice. To be re-evaluated...

// Data:
// The data is saved in a file (typ. /data/config/datafiles.json) and has the following structure:
// { ts: Date.now() when written
//   files: [
//     { dir: "/media/SGdata/2021-12-01", // dir holding the file
//       date: "YYYY-MM-DD",
//       name: "file1.txt.gz",
//       size: 12345, // in bytes
//       data_lines: 123, // number of tag detections for CTT, number of pulses for Lotek
//       uploaded: Date.now(), // timestamp of last upload to server, null otherwise
//       downloaded: Date.now(), // timestamp of last download via web interface, null otherwise
//     }]}
// The data file is written when something changes, e.g., an new file is started, an
// upload is performed, etc

const DATAFILE = "/data/config/DataFiles.json"

const Fs = require("fs")
const FSP = require("fs/promises")
const Path = require('path')

// find all files in a subtree and yield each file's {path, stat} in turn
// findFiles is an async generator (yay! ugh#%^), it will yield each {path,stat} value when 
// it's produced...
async function* findFiles(dir) {
    try {
        for (const file of await FSP.readdir(dir)) {
            const path = dir + "/" + file
            const stat = await FSP.stat(path)
            if (stat.isDirectory()) {
                yield* findFiles(path)
            } else {
                yield { path, stat }
            }
        }
    } catch (e) {
        console.log(`DataFiles failed to scan ${dir}: ${e}`)
    }
}

class DataFiles {

    constructor(matron) {
        this.matron = matron
        this.files = [] // to be populated from file plus discovery
        this.reading = true // we're reading the data file, so don't overwrite it yet
        matron.on("datafile", (path, info) => this.addFile(info, path, true))
        
        // summary information used by the dashboard
        this.summary = {
            total_files: 0, total_bytes: 0, pre_2010_files: 0,
            files_to_upload: 0, files_to_download: 0,
            bytes_to_upload: 0, bytes_to_download: 0,
            last_upload: null, last_download: null,
        }

        // plottable information about data records
        // det_by_day is a map of dates to a map of file types ("all", "ctt", ..) to the number of
        // detections, the date being of the form YYYYMMDD
        // det_by_hour is similar with the top-level key being the Date.now() of the hour
        this.det_by_day = { }
        this.det_by_hour = { }
    }

    // start tracking data files, begins by reading the file with info from previous runs, then
    // performs a scan of mounted media to see what we can find
    async start() {
        // read the datafile
        try {
            let info = JSON.parse(await FSP.readFile(DATAFILE))
            if (info.files) {
                info.files.forEach(i => this.addStats(i, false))
                this.files = this.files.concat(info.files)
                let iso = new Date(info.ts).toISOString()
                console.log(`DataFiles: read ${this.files.length} records written ${iso}`)
                this.pubStats()
            }
        } catch(e) {
            console.log(`DataFiles: cannot read ${DATAFILE}: ${e}`)
        }
        this.reading = false
        // update for every media device we have
        const old = this.files.length
        await this.updateTree("/data/SGdata")
        if (this.files.length != old) {
            await this.save()
            this.matron.emit("detection_stats", this.det_by_day, this.det_by_hour)
        }
    }

    // save the accumulated info about data files to a json file
    async save() {
        // at start-up we may be asked to save before we're done reading the old json info
        // prevent that from happening here.
        while (this.reading) await new Promise(res => setTimeout(res, 1000))
        this.reading = true // abuse the reading flag as lock against concurrent saves
        let info = { ts: Date.now(), files: this.files }
        await FSP.writeFile(DATAFILE + "~", JSON.stringify(info))
        await FSP.rename(DATAFILE + "~", DATAFILE)
        this.reading = false
        console.log(`DataFiles: saved ${this.files.length} records`)
    }

    // update information about data files starting at the given dir
    async updateTree(dir) {
        for await (const { path, stat } of findFiles(dir)) {
            const file_info = this.parseFilename(path)
            if (!file_info) continue // doesn't look like a data file
            // check whether we have this file already, and if not scan it and add it
            if (this.files.some(f => f.name === file_info.name)) continue
            const info = { ...file_info, ...await this.parseFile(path), size: stat.size }
            this.addFile(info, null, false)
        }        
    }
    
    // regexp to match changeMe-7F5ERPI46977-1-2021-12-11T14-46-38.8260Z-all.txt.gz
    datafileRE = /^(.*\/)([^-]*-[^-]*-[0-9]+-([-0-9]+)(T[-0-9.]+)[P-Z]-([a-z]+).txt(.gz)?)$/ // phew!
    
    // parse filename and return info contained therein
    parseFilename(path) {
        let mm = this.datafileRE.exec(path)
        if (!mm) return null
        const data = {
            dir: mm[1],
            date: mm[3].replace(/-/g, ""),
            start: new Date(mm[3] + mm[4].replace(/-/g, ":") + "Z"),
            name: mm[2],
            type: mm[5],
        }
        if (!data.date || !data.start) console.log("OOPS:", data)
        return data
    }

    // parse the specified file and return a tuple with: number of data lines, timestamp of first
    // and last data line, a boolean whether a GPS fix is recorded
    async parseFile(path) {
        //return { data_lines: 0, first_data: 0, last_data: 0, gps: false }
           
        let input = path.endsWith(".gz") ? Fs.createReadStream(path).pipe(Zlib.createGunzip())
                                         : Fs.createReadStream(path)
        input.setEncoding('utf8')
        let data_lines = 0
        let first_data = null
        let last_data = null
        let gps = false
        try {
            let lines = ""
            for await (const chunk of input) {
                //console.log(`DataFile chunk: ${chunk}`)
                lines = (lines+chunk).split("\n")
                while (lines.length > 1) {
                    let line = lines.shift()
                    //console.log("LINE:", line)
                    if (line.startsWith("G")) {
                        gps = true
                    } else if (line.startsWith("T") || line.startsWith("p")) {
                        data_lines++
                        const fields = line.split(",")
                        const ts = parseFloat(fields[1])
                        if (first_data === null) first_data = ts * 1000
                        last_data = ts * 1000
                    }
                }
                lines = lines[0]
            }
        } catch (e) {
            console.log(`DataFiles: ${e} in ${path}`)
        }
        return { data_lines, first_data, last_data, gps }
    }

    // add info about a data file and save all the info
    addFile(info, path=null, save=true) {
        // if path provided then parse it and add to info
        if (path) {
            const file_info = this.parseFilename(path)
            if (file_info)  info = { ...file_info, ...info }
        }
        const data = {
            ...info, // includes size
            uploaded: null,
            downloaded: null,
        }
        this.files.push(data)
        console.log(`DataFile added with ${data.data_lines} data lines: ${data.name}`)
        this.addStats(data, save)
        // save if desired
        if (save) {
            // delay and make async
            setTimeout(() => { this.save().then(()=>{}) }, 120)
        }
    }
    
    // add stats
    addStats(data, pub=true) {
        // update summary stats
        this.summary.total_files++
        this.summary.total_bytes += data.size
        if (data.date < '20100101') this.summary.pre_2010_files++
        if (!data.uploaded) { this.summary.files_to_upload++; this.summary.bytes_to_upload += data.size }
        if (!data.downloaded) { this.summary.files_to_download++; this.summary.bytes_to_download += data.size }
        if (data.uploaded && (!this.summary.last_upload || data.uploaded > this.summary.last_upload))
            this.summary.last_upload = data.uploaded
        if (data.downloaded && (!this.summary.last_download || data.downloaded > this.summary.last_download))
            this.summary.last_download = data.downloaded

        // update daily stats
        const ms_per_day = 24 * 3600 * 1000
        let start = data.first_data || data.start
        //if (start < (new Date('1999-12-12T00:00:00Z')).valueOf()) console.log("OOPS", start, data.first_data, data.start)
        const day = Math.trunc(start / ms_per_day) * ms_per_day
        if (!this.det_by_day[day]) this.det_by_day[day] = { }
        const day_det = this.det_by_day[day]
        day_det[data.type] = (day_det[data.type] || 0) + data.data_lines
        // prune daily to 100 days
        //console.log("det_by_day", day, this.det_by_day)
        let cutoff = Date.now() - 100*ms_per_day
        Object.keys(this.det_by_day).filter(k => !(k >= cutoff)).forEach(k => delete this.det_by_day[k])

        // same for hourly
        const hour = Math.trunc(start / (3600*1000)) * 3600*1000
        if (!this.det_by_hour[hour]) this.det_by_hour[hour] = { }
        const hour_det = this.det_by_hour[hour]
        hour_det[data.type] = (hour_det[data.type] || 0) + data.data_lines
        // prune hourly to 5 days
        cutoff = Date.now() - 5*ms_per_day
        Object.keys(this.det_by_hour).filter(k => !(k >= cutoff)).forEach(k => delete this.det_by_hour[k])
        
        if (pub) this.pubStats()
    }

    pubStats() {
        this.matron.emit("data_file_summary", this.summary)
        this.matron.emit("detection_stats", this.det_by_day, this.det_by_hour)
    }

}

module.exports = DataFiles
