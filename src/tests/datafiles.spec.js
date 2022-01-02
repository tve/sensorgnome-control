const { DataFiles, FileInfo } = require('datafiles.js')
var fs = require("fs")
OpenFiles = [] // normally provided by datafiles...

describe('FileInfo', () => {
  
    // beforeEach(() => {
    //   df = new FileInfo("/data/sg/2020-01-02/zyx-1234RPI4FEDC-3-2020-01-02T03-04-05.6789Z-all.txt.gz")
    // })
  
    it('constructs from path', () => {
      const df = new FileInfo("/data/sg/2020-01-02/zyx-1234RPI4FEDC-3-2020-01-02T03-04-05.6789Z-all.txt.gz")
      expect(df).toBeDefined()
      expect(df.toInfo()).toMatchObject({
          dir: "/data/sg/2020-01-02",
          date: "20200102",
          start: 1577934245,
          name: "zyx-1234RPI4FEDC-3-2020-01-02T03-04-05.6789Z-all.txt.gz",
          type: "all",
          size: 0, data_lines: 0, gps: false,
          first_data: null, last_data: null,
          uploaded: null, downloaded: null,
      })
    })

    it('throws on bad path', () => {
        expect(() => new FileInfo("/data/sg/2020-01-02/hello.txt.gz.gz")).toThrow()
    })

    it('parses data lines', () => {
        const df = new FileInfo("/data/sg/2020-01-02/zyx-1234RPI4FEDC-3-2020-01-02T03-04-05.6789Z-all.txt.gz")
        let info1 = { ... df.toInfo()}
        df.parseLine("XYZ")
        expect(df.toInfo()).toMatchObject(info1)
        // parse a CTT tag line
        df.parseLine("T,1578000000.456,ABCD1234")
        expect(df.toInfo()).toMatchObject({data_lines:1, first_data: 1578000000, last_data: 1578000000})
        // parse a Lotek pulse detection
        df.parseLine("p3,1639705179.4065,2.421,-32.78,-53.71")
        expect(df.toInfo()).toMatchObject({data_lines:2, first_data: 1578000000, last_data: 1639705179})
        // parse a GPS line
        df.parseLine("G,1234")
        expect(df.toInfo()).toMatchObject({data_lines:2, first_data: 1578000000, last_data: 1639705179, gps: true})
    })

    it('parses a chunk', () => {
        const df = new FileInfo("/data/sg/2020-01-02/zyx-1234RPI4FEDC-3-2020-01-02T03-04-05.6789Z-all.txt.gz")
        df.parseChunk("C,1639701724.527,2,0\np3,1639")
        df.parseChunk("701740.9523,2.433,-32.26,-53.49\np3,1639701740.9743")
        df.parseChunk(",2.5,-32.62,-53.56\np3,163970174")
        df.parseChunk("1.9938,2.501,-32.4,-53.55\n")
        expect(df.toInfo()).toMatchObject({
            data_lines:3, first_data: 1639701740, last_data: 1639701741
        })
    })

    it('parses text files', async () => {
        // a lotek file
        let df = new FileInfo("../test_assets/2021-12-17/changeMe-7F5ERPI46977-3-2021-12-17T01-42-00.2190Z-all.txt")
        await df.parseFile(1234)
        expect(df.toInfo()).toMatchObject({
            data_lines:36, first_data: 1639705329, last_data: 1639705530, gps:false, size:1234
        })
        // a CTT file
        df = new FileInfo("../test_assets/2021-12-17/changeMe-7F5ERPI46977-3-2021-12-17T01-42-00.3850Z-ctt.txt")
        await df.parseFile()
        expect(df.toInfo()).toMatchObject({
            data_lines:43, first_data: 1639705321, last_data: 1639705536, gps:false, size:0
        })
    })

    it('parses gzip files', async () => {
        // a lotek file
        let df = new FileInfo("../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T04-25-02.0960Z-all.txt.gz")
        await df.parseFile(5678)
        expect(df.toInfo()).toMatchObject({
            data_lines:614, first_data: 1639628706, last_data: 1639632295, gps:false, size:5678
        })
        // a CTT file
        df = new FileInfo("../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T04-25-02.2850Z-ctt.txt.gz")
        await df.parseFile()
        expect(df.toInfo()).toMatchObject({
            data_lines:700, first_data: 1639628702, last_data: 1639632297, gps:false, size:0
        })
    })
})

describe('DataFiles', () => {
    let df
    let matron
    let m_on = {}
  
    beforeEach(() => {
        matron = {
            on: jest.fn((topic, fun) => { m_on[topic] = fun}),
            emit: jest.fn((topic, ...args) => { if (topic in m_on) m_on[topic](...args) }),
        }
        try { fs.unlinkSync("/tmp/test_datafile.json") } catch(e){}
        df = new DataFiles(matron, "../test_assets", "/tmp/test_datafile.json")
        Machine = {machineID: "7F5ERPI46977"} // global
    })

    afterEach(() => {
        try { fs.unlinkSync("/tmp/test_datafile.json") } catch(e){}
        Machine = null // any way to delete it?
    })

    it('constructs', () => {
        expect(df).toBeDefined()
        expect(m_on["datafile"]).toBeDefined()
    })

    it('adds a file before reading existing stats', async () => {
        df.saveSoon = jest.fn(()=>{})
        df.reading = true // prevent addFiles from publishing stats
        let info = new FileInfo(
            "../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T04-25-02.2850Z-ctt.txt.gz")
        matron.emit('datafile', info.toInfo())
        expect(df.files).toHaveLength(1)
        expect(df.saveSoon.mock.calls.length).toBe(1)
    })

    describe('add stats to summary, hourly, and daily', () => {
        let dn

        beforeEach(async () => {
            dn = Date.now
            Date.now = () => 1639804221708
            let info = new FileInfo(
                "../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T04-25-02.2850Z-ctt.txt.gz")
            await info.parseFile(1324)
            df.addStats(info.toInfo(), false)
        })

        afterEach(() => {
            Date.now = dn
        })
        
        test('first file is added correctly', () => {
            expect(df.summary).toMatchObject({
                total_files: 1, total_bytes: 1324, pre_2010_files: 0, other_sg_files: 0
            })
            expect(df.det_by_day).toMatchObject({1639612800: {ctt:700}})
            expect(df.det_by_hour).toMatchObject({1639627200: {ctt:700}})
        })

        // add a file the same day and one another day
        test('adding two more files', async () => {
            df.pubStats = jest.fn(()=>{})
            // another hour
            let info1 = new FileInfo(
                "../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T05-25-02.4760Z-ctt.txt.gz")
            await info1.parseFile(1200)
            df.addStats(info1.toInfo(), true)
            // another day
            let info2 = new FileInfo(
                "../test_assets/2021-12-17/changeMe-7F5ERPI46977-3-2021-12-17T01-50-41.1150Z-all.txt")
            await info2.parseFile(55)
            df.addStats(info2.toInfo(), true)
            // expectations
            expect(df.summary).toMatchObject({
                total_files: 3, total_bytes: 1324+1200+55, pre_2010_files: 0, other_sg_files: 0
            })
            expect(df.pubStats.mock.calls.length).toBe(2)
            expect(df.det_by_day).toMatchObject({
                1639612800: {ctt:1403}, 1639699200: {all:217}
            })
            expect(df.det_by_hour).toMatchObject({
                1639627200: {ctt:700}, 1639630800: {ctt:703}, 1639702800: {all:217}
            })
        })
    })

    it('parses a whole directory of files', async () => {
        await df.updateTree("../test_assets/2021-12-17")
        expect(df.files).toHaveLength(18)
        expect(df.files[0]).toMatchObject({dir: "../test_assets/2021-12-17"})
        expect(df.summary.total_files).toBe(18)
        expect(df.summary.total_bytes).toBe(25310)
    })

    it('does not throw on error', async () => {
        await df.updateTree("../test_assets/2021-12-xx")
        expect(df.files).toHaveLength(0)
    })

    describe('manages download lists', () => {
        beforeEach(async () => {
            df.saveSoon = jest.fn(()=>{})
            await df.updateTree("../test_assets/2021-12-16")
            df.updateStats()
            expect(df.files).toHaveLength(20)
        })

        test('download all', () => {
            let dll = df.downloadList('all')
            expect(dll).toHaveLength(20)
        })

        test('download new', () => {
            let dll = df.downloadList('new')
            expect(dll).toHaveLength(20)
        })

        test('updateDownloadDate with download', () => {
            const total_size = 88522

            // get the initial download list where all are candidates
            let dll = df.downloadList('new')
            expect(dll).toHaveLength(20)
            expect(df.summary).toMatchObject({
                total_files: 20, total_bytes: 88522, pre_2010_files: 0, other_sg_files: 0,
                files_to_upload: 20, files_to_download: 20,
                bytes_to_upload: 88522, bytes_to_download: 88522,
            })

            // check that filenames returned actually point to files
            // also tally total size
            for (let f of dll) expect(fs.existsSync(f)).toBe(true)
            
            // pretend we download 8 files
            const del = dll.splice(3, 8)
            const size = del.reduce((acc, f) => acc + fs.statSync(f).size, 0)
            const ts = Date.now()/1000
            df.updateUpDownDate('downloaded', del, ts)
            expect(df.summary).toMatchObject({
                total_files: 20, total_bytes: total_size, pre_2010_files: 0, other_sg_files: 0,
                files_to_upload: 20, files_to_download: 20-del.length,
                bytes_to_upload: total_size, bytes_to_download: total_size-size,
            })
            expect(df.summary.last_download).toBe(ts)
            expect(df.saveSoon.mock.calls.length).toBe(1)

            const dll2 = df.downloadList('new')
            expect(dll2).toHaveLength(20-del.length)
            expect(dll2).toEqual(dll)

            const dll3 = df.downloadList('last')
            expect(dll3).toHaveLength(del.length)
            expect(dll3).toEqual(del)
        })

        test('updateDownloadDate with upload', () => {
            const total_size = 88522

            // get the initial upload list where all are candidates
            let {date, files} = df.uploadList()
            expect(files).toHaveLength(20)
            expect(df.summary).toMatchObject({
                total_files: 20, total_bytes: 88522, pre_2010_files: 0, other_sg_files: 0,
                files_to_upload: 20, files_to_download: 20,
                bytes_to_upload: total_size, bytes_to_download: total_size,
            })
            for (let f of files) expect(fs.existsSync(f[0])).toBe(true)

            // pretend we upload 10 files
            const del = files.splice(3, 10)
            const size = del.reduce((acc, f) => acc + f[1], 0)
            const info = { date: Date.now()/1000, foo: 'bar' }
            const del_files = del.map(f => f[0])
            df.updateUpDownDate('uploaded', del_files, info)
            expect(df.summary).toMatchObject({
                total_files: 20, total_bytes: total_size, pre_2010_files: 0, other_sg_files: 0,
                files_to_upload: 10, files_to_download: 10,
                bytes_to_upload: total_size-size, bytes_to_download: total_size-size,
            })
            expect(df.summary.last_upload).toBe(info.date)
            expect(df.saveSoon.mock.calls.length).toBe(1)
        })

    })

    it('starts alright', async () => {
        // pre-load some files
        await df.updateTree("../test_assets/2021-12-16")
        expect(df.files).toHaveLength(20)
        expect(df.summary.total_bytes).toBe(88522)
        // call 'start' and expect that it pulls in the rest of the files
        df.save = jest.fn(()=>{})
        df.pubStats = jest.fn(()=>{})
        await df.start()
        expect(df.files).toHaveLength(38)
        expect(df.summary.total_bytes).toBe(25310+88522)
        expect(df.save.mock.calls.length).toBe(1)
        expect(df.pubStats.mock.calls.length).toBe(1)
    })

})
