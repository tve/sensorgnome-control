const ts = require('./timeseries.js')
const fs = require('fs')

const dir = fs.mkdtempSync('/tmp/testtimeseries-')
const tNow = Math.trunc(Date.now()/600000)*600000

// test that inserting some simple data works
try {
  let cnt = 1
  for (let tAt of [tNow, tNow + 60000]) {
    const ts1 = new ts(dir, 'test'+cnt)
    ts1.add(tAt, 1)
    ts1.add(tAt + 1000, 2)
    ts1.ranges.forEach((r, i) => {
      const [t,v] = ts1.get(r, tAt)
      const lim = ts1.limits[i]
      if (t.length != lim) {
        throw new Error(`expected ts1.limit[i] array for ${r}, got ${t.length}`)
      }
      if (v.length != lim) {
        throw new Error(`expected ts1.limit[i] array for ${r}, got ${v.length}`)
      }
      const tAt_trunc = Math.trunc(tAt/ts1.intervals[i])*ts1.intervals[i]
      if (t[lim-1] != tAt_trunc) {
        console.log(tAt/1000, tAt_trunc/1000, t[lim-1]/1000)
        throw new Error(`expected ${tAt_trunc} for ${r}, got ${t[lim-1]}, delta ${t[lim-1]-tAt_trunc}`)
      }
      if (v[lim-1] != 3) {
        throw new Error(`expected 3 for ${r}, got ${v[lim-1]}`)
      }

    })
    cnt++
  }
} catch (e) {
  console.log("In test 1:", e)
}

// test that inserting a bunch of data rolls over correctly
try {
  const ts2 = new ts(dir, 'test3')
  const five = 5 * 60 * 1000
  const count = 4*6*3
  for (let i = 0; i < count; i++) {
    ts2.add(tNow + i*five, i)
  }
  const tLast = tNow + (count-1)*five
  //console.log("ts2.get:", ts2.get('4hours', tLast))
  const [times, values] = ts2.get('4hours', tLast)
  const t0 = tNow + five*4*6
  const v0 = 4*6*2
  for (let i = 0; i < 4*6; i++) {
    const texp = t0 + i * 10*60*1000
    const tgot = times[i]
    if (tgot != texp) {
      throw new Error(`expected ${texp} , got ${tgot}, delta ${tgot-texp}`)
    }
    const vexp = v0 + 4*i + 1
    const vgot = values[i]
    if (vgot != vexp) {
      throw new Error(`expected ${vexp} , got ${vgot}, delta ${vgot-vexp}`)
    }
  }
} catch (e) {
  console.log("In test 2:", e)
}
