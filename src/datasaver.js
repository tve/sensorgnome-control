/*

  DataSaver.js - provide file-based writeableStreams to clients who
  can then save data to them.  Deal with generating correct filenames.

  Required globals: GPS, Deployment, Machine

Note: output streams should use output files, not fs.fileWriteSTreams,
so we can detect how many bytes short we are on a write, and resend
once the file stream is re-opened on another disk.  Currently, we'll
lose one chunk of data (probably less than a second) when writing a .wav
to the end of one disk and continuing on another.

   Data File Nomenclature and Placement
   ====================================

   <datadir>/BOOT_COUNT/YYYY-MM-DD/DEPLOYMENT_CODE-MACHINE_ID-BOOT_COUNT-YYYY-MM-DDTHH-MM-SS.SSSSC-SRC.EXT

   - DEPLOYMENT_CODE is short user string containing no "-" (any "-" are replaced by "_")

   - MACHINE_ID is the 12 unique beaglebone/rpi id (/etc/sensorgnome/id)

   - BOOT_COUNT is zero-padded 6-digit boot count

   - timestamp is precise to 0.1 ms and is UTC; (YYYY-MM-DDTHH-MM-SS.SSSS)

   - timestamp code (C) is
      - Z: timestamp was obtained after the GPS set the clock, so should be good
      - P: timestamp was obtained before the GPS set the clock, so may be very wonky
      - A: timestamp was obtained before the GPS set the clock, but corrected post-hoc (and so is approximately correct)

   - SRC is a USB port number, for raw .wav data files; otherwise, it is a string from
     this list:
      - "all": output from every plugin on every port; the first item in each output line
        should be the port identifier (e.g. "p1", "p2", ...)

   - EXT is a file extension:
     .txt - for temporary ascii file written as data are available
     .txt.gz - for compressed .dat file; after writing, we delete the original .txt
     .wav - for raw audio

Note December 2021: this module used to watch disk mounts and switch from one disk to the next
when full. This is no longer done: all the data is in one place, which, given the size of
SDcards should be fine. The SensorStation has been operating this way for a while. Plugging disks
in is probably better used for download/backup purposes.

*/

class DataSaver {
    constructor(matron, datadir) {
        this.matron = matron
        this.datadir = datadir
    }

    // Get a string list of path components to a data file; the last component is the file
    // basename (without extension).
    // If timestamp is specified as "%", it is replace with strftime-compatible formatting codes
    // so a subsequent function can fill in time once it is known.
    getRelPath(source, timestamp) {
        timestamp = timestamp || Date.now() / 1000
        let tscode = Chrony.timeStampCode()
        if (tscode != "P") tscode = "Z" // don't get into the fine details of clock sync
        let date, dayPart
        if (timestamp == "%") {
            date = "%Y-%m-%dT%H-%M-%S%QQQQQQ" + tscode
            dayPart="%Y-%m-%d"
        } else {
            var digit4 = Math.round(timestamp * 10000) % 10
            date = (new Date(Math.floor(timestamp * 1000))).toISOString()
                .replace(/:/g,"-").replace(/Z/, digit4 + tscode )
            dayPart = date.substring(0, 10)
        }

        const shortLabel = Deployment.short_label.replace(/-/g, '_')
        let basename = [shortLabel, Machine.machineID, Machine.bootCount, date, source].join('-')
        return [dayPart, basename]
    }

    // getStream returns a writeable stream open under the given path (specified as a list of
    // directory components and the file basename) and the file extension .
    // relpath: a list of relative file path components, as returned by getRelPath().
    // ext: a file extension (including the leading '.')
    // pathOnly: if present and true, does not open a stream, but only
    // ensures appropriate directories exist and returns the full path
    // Returns { stream: WritableStream, path: absolute path } or null if no stream can be opened.
    getStream(relpath, ext, pathOnly) {
        try {
            var path_list = [this.datadir, ...relpath]
            this.ensureDirs(path_list)
            var path = path_list.join("/") + ext
            if (pathOnly)  return path

            var sout = Fs.createWriteStream(path)
            console.log(`DataSaver: opening ${path}`)
            return {stream:sout, path: path}
        } catch (e) {
            throw new Error("DataSaver.getStream: unable to open stream for " + relpath.join("/") + ext);
        }
    }

    // ensure the dirs in the path (excl last component) exist
    // FIXME: this hsould be async, but then the async function cancer spreads...
    ensureDirs(path) {
        var cumdir = path[0]
        for (let i=1; i<path.length-1; i++) {
            cumdir += "/" + path[i]
            if (! Fs.existsSync(cumdir)) Fs.mkdirSync(cumdir)
        }
    }

}

exports.DataSaver = DataSaver
