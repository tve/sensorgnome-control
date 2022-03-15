// motus_up - upload files to motus.org
// Copyright ©2021 Thorsten von Eicken

        // in theory we can stream the archive into the request body, but for some reason this
        // produces a different stream, most likely something in archiver is non-deterministic


const AR = require('archiver')
const { createWriteStream, createReadStream } = require('fs')
const stream = require('stream')
const centra = require("./centra.js")
const Path = require('path')
const { promisify } = require('util')
const pipeline = promisify(stream.pipeline)
const crypto = require('crypto')
const { Buffer } = require('buffer')

// Globals: DataFiles, Machine

const SERVER = 'https://motus.org'
const URL_TEST = '/data'
const URL_VERIFY = '/data/project/sgJobs'
const URL_UPLOAD = '/data/project/sgJobs'
const URL_LOGIN = '/data/login'
const URL_CONN = 'http://connectivitycheck.gstatic.com/generate_204' // Android connectivity check
const MAX_SIZE = 10*1024*1024 // 10MB max archive size (well, actually a little more)

// simple class that acts like a stream writer and produces the SHA1 of the stream
// class StreamingSHA1 extends stream.Writable {
//     constructor() {
//         super()
//         this.sha1 = crypto.createHash('sha1')
//         this.digest_ = null
//         this.resolver = null
//         this.sz = 0
//     }
//     _write(data, enc, next) {
//         this.sha1.update(data)
//         this.sz += data.length
//         next()
//     }
//     _final(next) {
//         this.digest_ = this.sha1.digest('hex')
//         if(this.resolver) this.resolver(this.digest_)
//         next()
//     }
//     digest() {
//         return new Promise((resolve, reject) => {
//             if (this.digest_) resolve(this.digest_)
//             else this.resolver = resolve
//         })
//     }
// }

// https://stackoverflow.com/a/67729663/3807231
function stream2buffer(stream) {
    return new Promise((resolve, reject) => {
        const _buf = []
        stream.on("data", (chunk) => _buf.push(chunk))
        stream.on("end", () => resolve(Buffer.concat(_buf)))
        stream.on("error", (err) => reject(err))
    })
}

function buffer2sha1(buffer) {
    const sha1 = require('crypto').createHash('sha1')
    sha1.update(buffer, 'binary')
    return sha1.digest('hex')
}

class MotusUploader {
    constructor(matron) {
        this.matron = matron
        //this.active = false // whether the uploader is active
        this.session = null // session cookie

        // start when the initial reading of the datafiles state is completed
        matron.on('datafile_summary', ()=> this.start())  // FIXME: start should only be called once !?
        matron.on('dash-upload', () => this.uploadSoon())
        matron.on('motus', status => { if (status == "OK") this.uploadSoon(true) })
    }

    start() {
        this.uploadSoon()
        this.matron.on("datafile", () => this.uploadSoon())
    }

    // schedule an upload to happen "soon"
    // An underlying assumption is that that uploadSoon gets triggered about every hour by
    // the cutting of a datafile and also when connectivity to Motus is detected, thus there's no
    // explicit retry timer. (Perhaps we should have one in case of a temporary 500 error?)
    uploadSoon(force=false) {
        if (this.timer) return // already scheduled/running (ignore race condition)
        this.timer = setTimeout(() => {
            this.doUploadAll()
            .then(() => { this.timer = null }) // next upload will be triggered by a datafile event
            .catch(() => { this.timer = null }) // next upload will be triggered by a datafile event
        }, force ? 200 : 5000)
        return
        // define function to perform upload
        // This code reschedules in case of failure, commented out for now for simplicity, prob better
        // to keep it simple and just rely on the next datafile event...
        const sched = (delay) => setTimeout(() => {
            this.active = true
            this.timer = null
            this.doUploadAll()
                .then(() => {
                    this.active = false // next upload will be triggered by a datafile event
                })
                .catch(e => {
                    this.active = false
                    this.timer = sched(10*1000) // set timer for retry FIXME: make 3700 secs
                }) // try again in a little over an hour
            }, delay)
        // if not forced (via UI) and upload isn't already scheduled or active then schedule it
        if (!force) {
            if (!this.timer && !this.active) this.timer = sched(20*1000)
        // if forced and not already running then schedule it (almost) immediately
        } else if (!this.active) {
            if (this.timer) clearTimeout(this.timer)
            this.timer = sched(200)
        }
    }

    // helper function to perform uploads until there's nothing left (or an error occurs)
    async doUploadAll() {
        while (await this.doUpload()) {}
    }

    // perform an upload to motus.org, returns true if there's more to do, false if done.
    async doUpload() {
        let {date, files} = DataFiles.uploadList()
        // files is [path, size, unix_timestamp]
        if (!files) {
            console.log("Motus upload: no files to upload")
            return false
        }
        if (!WifiMan.motus_status == "OK") {
            console.log("Motus upload: not connected to motus.org")
            throw new Error("not connected to motus.org")
        }
        console.log(`Checking Motus upload of ${files.length} files`)
        try {
            //await this.test_inet_connectivity()
            const login_url = SERVER+URL_LOGIN // await this.test_motus_connectivity()
            this.session = await this.login(login_url, Deployment.upload_username, Deployment.upload_password)
            const upload_info = await this.performFilesUpload(files)
            DataFiles.updateUpDownDate('uploaded', files.map(f=>f[0]), upload_info)
            return true
        } catch(e) {
            console.log(e.message)
            throw e
        }
    }

    // perform an upload of the given files. Assumes we're already logged (this.session has cookie).
    // Returns upload info if successful, null if duplicate, throws otherwise.
    async performFilesUpload(files) {
        let filename
        try {
            // start by getting the archive and its SHA1
            const { archive, sha1 } = await this.archive_sha1(files)
            // we need a filename for the archive, use the date of the first file plus a part of the sha1
            const date = (new Date(files[0][2]*1000)).toISOString().replace(/-/g, '').replace(/T.*/, "")
            filename = `SG-${Machine.machineID}-${date}-${sha1.substr(0,8)}.zip`
            console.log(`Motus upload starting for ${filename} with ${files.length} files`)
            //console.log(`***** computed SHA1: ${sha1}`)
            // issue de-duplication verification request
            const [proceed, info] = await this.verify_archive(sha1, filename)
            if (!proceed) {
                console.log("Files have already been uploaded:", info)
                return info
            }
            const filePartName = info
            console.log(`Motus upload filePartName: ${filePartName}`)
            // upload the archive
            await this.upload_archive(archive, filePartName)
            // finalize the upload
            const uploadInfo = await this.upload_finalize(filename, filePartName)
            const fileList = files.map(f => f[0]).join('\n')
            console.log(`*** Motus upload ${filename} complete, JobID: ${uploadInfo.jobid}, files:\n${fileList}`)
            return uploadInfo
        } catch(e) {
            //e.message = `Motus upload ${filename} failed: ${e.message}` // works unless e.stack has been called
            throw e
        }
    }

    // // test connectivity to motus and return the login URL if reachable. Throws otherwise.
    // async test_motus_connectivity() {
    //     try {
    //         const resp = await centra(SERVER+URL_TEST, 'GET')
    //             .timeout(20*1000)
    //             .send()
    //         if (resp.statusCode == 302) { // redirect to login
    //             return resp.headers.location
    //         }
    //         throw new Error(`Motus conn check got unexpected response code: ${resp.statusCode}`)
    //     } catch (e) {
    //         throw new Error(`Motus conn check cannot reach ${SERVER}: ${e.message}`)
    //     }
    // }

    // login to Motus. On success returns session cookie, on bad user/pass returns null,
    // on error throws an exception
    async login(login_url, user, pass) {
        const resp = await centra(login_url, 'POST')
            .body({ login_name: user, login_password: pass }, 'form')
            .timeout(20*1000)
            .send()
        //console.log(`Motus login response: ${resp.statusCode} ${JSON.stringify(resp.headers)}`)
        if (resp.statusCode != 302) throw new Error(`Motus login error: status ${resp.statusCode}`)
        if (resp.headers.location) throw new Error("Motus login: bad user/pass")
        return resp.headers['set-cookie']
    }

    // consume the provided file iterator until the archive max size is exceeded and return
    // the set of files that were consumed, plus true if the iterator is exhausted
    file_chunk(file_iter) {
        let size_sum = 0
        const files = []
        for (const [file, size, date] of file_iter) {
            size_sum += size
            files.push([file, size, date])
            if (size_sum > MAX_SIZE) return [files, false]
        }
        return [files, true] // signal that iterator is done
    }

    // return a readable stream that contains the archive
    startArchiveStream(files) {
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        for (const [f, sz, d] of files) {
            archive.file(f, { name: Path.basename(f), date: new Date(d*1000) })
        }
        archive.finalize()
        return archive
    }
    
    // produce an archive from the files and compute its SHA1, return archive and sha1
    async archive_sha1(files) {
        // start archive streaming
        const arstream = this.startArchiveStream(files)
        let error = null
        arstream.on('error', (msg) => { if (!error) error = new Error(msg) })
        // pipe into hasher
        // const hasher = new StreamingSHA1()
        // await pipeline(arstream, hasher)
        // locad into buffer and get sha1
        const archive = await stream2buffer(arstream)
        if (error) throw error
        const sha1 = buffer2sha1(archive)
        // that's it...
        console.log(`SHA1: ${sha1}, length: ${archive.length}`)
        return { archive, sha1 }
    }

    // dump the archive to a file (mostly for troubleshooting/testing purposes)
    async dump_archive(files, dest) {
        // start archive streaming
        const archive = this.startArchiveStream(files)
        let error = null
        archive.on('error', (msg) => { if (!error) error = new Error(msg) })
        // pipe into write stream
        const out = new createWriteStream(dest)
        await pipeline(archive, out)
        // that's it...
        if (error) throw error
        // apparently pipeline doesn't call end?
        await new Promise((res,rej)=>{out.end(undefined, undefined, ()=>res())})
    }

    // make a request to motus.org to validate the proposed archive, this is just a "quick"
    // de-duplicate test to make sure this archive hasn't been uploaded already
    // If the upload is to proceed returns true and the "filePartName"; if it's a duplicate
    // returns false and the uploadInfo, if the request errors it throws.
    async verify_archive(archive_sha1, filename) {
        const t0 = Date.now()
        const resp = await centra(SERVER + URL_VERIFY)
            .query({ projectID: 460, verifyHash: archive_sha1, fileName: filename })
            .header({ cookie: this.session })
            .timeout(300*1000)
            .send()
        console.log("Verify completed in", Date.now() - t0, "ms")
        if (resp.statusCode == 200) {
            const txt = await resp.text()
            if (txt.startsWith('<')) throw new Error(`Upload verify got non-json response`)
            const j = JSON.parse(txt)
            //console.log("Upload verify response:", JSON.stringify(j))
            if ("filePartName" in j) return [ true, j.filePartName]
            if (j.error) throw new Error(`Upload verify error: ${j.error}`)
            if (j.msg) console.log(`Upload verify: ${j.msg.replace(/[\n\r]/sg, " ")}`)
            // parse prior upload info from msg: "This file has already been uploaded by Thorsten
            // von Eicken\r\n(2021-12-22 05:43:24; jobID: 11412821)"
            const mm = j.msg.match(/\((20[-0-9]{8}) ([:0-9]{8}); *jobID: ([0-9]+)\)/s)
            if (mm && mm.length == 4) {
                const date = Math.trunc((new Date(`${mm[1]}T${mm[2]}Z`)).getTime()/1000)
                return [ false, { jobid: mm[3], date } ]
            }
            throw new Error(`Upload verify result unparseable: ${j.msg}`)
        }
        if (resp.statusCode == 302) {
            throw new Error("Upload verify got redirect, bad password? " + resp.headers.location)
        }
        throw new Error(`Upload verify error: status ${resp.statusCode}`)
    }

    // Perform a POST to motus.org to upload an archive with the provided files.
    // Returns the filePartName if successful. Throws otherwise.
    async upload_archive(archive, filePartName) {
        // start the request
        const t0 = Date.now()
        const resp = await centra(SERVER + URL_UPLOAD, 'POST')
            .query({ projectID: 460, filePartName, action: "start" })
            .header({ cookie: this.session, 'Content-Type': 'application/zip' })
            .timeout(120*1000) // FIXME: may need to calculate based on archive size
            .body(archive)
            .send()
        console.log("Motus upload completed in", Date.now() - t0, "ms")
        const txt = await resp.text()
        if (resp.statusCode == 200) {
            if (txt.startsWith('<')) throw new Error(`Motus upload got non-json response`)
            const j = JSON.parse(txt)
            //console.log("Motus upload response:", JSON.stringify(j))
            if ("fileName" in j) return j.fileName
            throw new Error("Motus upload failed: " + j.error)
        }
        throw new Error(`Motus upload error: status ${resp.statusCode}`)
    }

    // Perform a GET (sic) request to Motus to "transfer" the uploaded file to "sg processing".
    // Returns the JobID if successful. Throws otherwise.
    async upload_finalize(localFileName, filePartName) {
        const resp = await centra(SERVER + URL_UPLOAD, 'GET')
        .query({ projectID: 460, localFileName, filePartName, action: 'transfer' })
        .header({ cookie: this.session })
        .send()
        const txt = await resp.text()
        if (resp.statusCode == 200) {
            if (txt.startsWith('<')) throw new Error(`Motus upload finalize got non-json response`)
            const j = JSON.parse(txt)
            //console.log("Motus upload finalize response:", JSON.stringify(j))
            if ("error" in j) throw new Error("Motus upload finalize failed: " + j.error)
            // we get an abomination back: {"msg":"Preliminary processing of your file has occurred:
            // Job ID: 11412766; new path: &#47;sgm&#47;uploads&#47;&#47;27319&#47;27319_2021-12-22T05-36-42.713_foo.zip"}
            const mm = j.msg.match(/Job ID: (\d+);.*_(20[-0-9]{8}T)([-0-9]{8})\./)
            if (mm && mm.length == 4) {
                const date = Math.trunc((new Date(`${mm[2]}${mm[3].replace(/-/g,':')}Z`)).getTime()/1000)
                return { jobid: mm[1], date }
            }
            throw new Error(`Motus upload finalize result unparseable: ${j.msg}`)
        }
        throw new Error(`Motus upload finalize error: status ${resp.statusCode}`)
    }

}

module.exports = { MotusUploader }
