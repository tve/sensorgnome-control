const { MotusUploader, StreamingSHA1 } = require('motus_up.js')
const fs = require("fs")
const stream = require('stream')
const { promisify } = require('util')
const pipeline = promisify(stream.pipeline)
const cp = require('child_process')

describe('StreamingSHA1', () => {
  
    it('produces the right sha for a sample file', async () => {
      const rs = fs.createReadStream("../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T00-25-01.6590Z-all.txt.gz")
      const sha1sum = "d24e654492b5a67ba643d4ed94ea7ad7ee782a00" // linux sha1sum command
      const sha1 = new StreamingSHA1()
      await pipeline(rs, sha1)
      const digest = await sha1.digest()
      expect(digest).toBe(sha1sum)
    })

})

describe('MotusUploader', () => {
    let mup
    let matron
    let m_on = {}
  
    beforeEach(() => {
        matron = {
            on: jest.fn((topic, fun) => { m_on[topic] = fun}),
            emit: jest.fn((topic, ...args) => { if (topic in m_on) m_on[topic](...args) }),
        }
        mup = new MotusUploader(matron)
    })

    describe('archive_sha1', () => {
        it('produces the same sha as sha1sum', async () => {
            // produce an archive
            const files = [
                "../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T00-25-01.6590Z-all.txt.gz",
                "../test_assets/2021-12-16/changeMe-7F5ERPI46977-3-2021-12-16T00-25-01.8450Z-ctt.txt.gz",
            ].map(f => [f, 6000, (new Date('2021-12-16T00:25:01Z')).getTime()/1000])
            await mup.dump_archive(files, "/tmp/test_zip.zip")
            // run sha1sum to get the sha1
            const sha1sum = cp.execSync("sha1sum /tmp/test_zip.zip").toString().split(" ")[0]
            // run archive_sha1
            const sha1 = await mup.archive_sha1(files)
            expect(sha1).toBe(sha1sum)
        })

    })
})
