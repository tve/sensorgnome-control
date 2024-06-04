// timeseries - Store simple event time-series
// Copyright ©2023 Thorsten von Eicken, see LICENSE

const path = require('path')
const fs = require('fs')

// allTS holds all in-memory time-series; this is used to avoid a race condition when closing
// a time-series and immediately reopening it. The final save is async while the opening load
// is sync and the latter occurs when the former is still writing the file...
const allTS = {}

let cnt = 0; // to name temp files before renaming

class TimeSeries {
  static ranges = ['5mins', 'hour', 'day', 'month', 'year']
  static intervals = [10000, 60*1000, 3600*1000, 24*3600*1000, 7*24*3600*1000] // 10min, 1h, 1d, 1w
  static limits = [5*6, 60, 25, 32, 53] // number of samples to keep
  
  constructor(dir, name) {
    const p = path.join(dir, name+'.json')
    if (allTS[p]) return allTS[p]

    this.name = name
    this.path = p
    this.dirty = false
    this.load()
    allTS[p] = this
    // this.data[range][limit] = array of event counts (ints) for each range
    // this.t0[range] = time of first sample
    // this.sum[range] = for avg: sum of values going into last last
    // this.cnt[range] = for avg: number of values going into last last
  }

  close() {
    if (this.dirty) this.save(() => { delete allTS[this.path] })
  }

  // clear the time series such that the last point covers time `at`
  clear(at) {
    console.log(`Clearing time series ${this.name} at ${this.path}`)

    if (!this.data) {
      this.data = {}
      this.t0 = {}
      this.sum = {}
      this.cnt = {}
    }

    for (let ix in TimeSeries.ranges) this.clear_range(at, ix)
    this.dirty = true
  }

  clear_range(at, ix) {
    const r = TimeSeries.ranges[ix]
    console.log(`Clearing range ${r} of time series ${this.name} at ${this.path}`)
    const interval = TimeSeries.intervals[ix]
    const limit = TimeSeries.limits[ix]
    const t0 = (Math.trunc(at/interval) - limit + 1) * interval
    // const tLast = t0 + (TimeSeries.limits[ix]-1)*interval
    this.data[r] = Array(limit).fill(null)
    this.t0[r] = t0
    this.sum[r] = 0
    this.cnt[r] = 0
  }

  // ensure the last element in the time series covers time `at`
  // then perform append by calling func with each range and range-index
  append(at, fill, func) {
    if (!'data' in this) {
      throw new Error("TimeSeries: not initialized " + this.name)
    }
    if (at > Date.now()+60000)
      throw new Error(`TimeSeries: can't insert data into the future, ${this.name}, ${at}, ${Date.now()}`)
    if (fill === undefined) fill = 0

    TimeSeries.ranges.forEach((r, i) => {
      const interval = TimeSeries.intervals[i]
      const limit = TimeSeries.limits[i]
      if (this.data[r].length != limit) {
        console.log(`TimeSeries: ${this.name} ${r} length is ${this.data[r].length}, should be ${limit}`)
        this.clear(at)
      }

      let tLast = this.t0[r] + (limit-1)*interval
      let offset = Math.floor((at-tLast)/interval)

      if (offset > limit) {
        // too far in the future, clear the data
        console.log(`TimeSeries: ${this.name} ${r} time jumped forward beyond end of data`)
        console.log(`At=${new Date(at).toISOString()} now=${new Date().toISOString()} end=${new Date(tLast).toISOString()}`)
        this.clear_range(at, i)
        offset = 0
        this.dirty = true
      }  

      if (offset < 0) {
        // can't insert data into the past
        // if (offset > -5) {
          const ago = (tLast-at)/1000
          console.log(`TimeSeries: dropping incoming data for the past (${ago}s ago) for ${this.name} ${r}`)
          console.log(`At=${new Date(at).toISOString()} now=${new Date().toISOString()} end=${new Date(tLast).toISOString()}`)
          return
        // } else {
        //   throw new Error(`TimeSeries: can't insert data into the past: ` +
        //   `${this.name} ${r} at=${at} last=${tLast} offset=${offset} ival=${interval} now=${Date.now()}`)
        // }
      }

      if (offset > 0) {
        // add null samples to catch up
        this.data[r] = this.data[r].slice(offset).concat(Array(offset).fill(fill))
        this.t0[r] += offset*interval
        this.sum[r] = 0
        this.cnt[r] = 0
        //this.dirty = true
      }

      if (func) func(r, i)
    })
  }

  // add a new event to the time series
  // at: Date().now timestamp; n: number of events to add (typ. 1)
  add(at, n) {
    this.append(at, 0, (r, i) => {
      this.data[r][TimeSeries.limits[i]-1] += n
    })
    this.dirty = true
  }

  // average a new value into the time series
  avg(at, v) {
    this.append(at, null, (r, i) => {
      this.sum[r] += v
      this.cnt[r] += 1
      this.data[r][TimeSeries.limits[i]-1] = this.sum[r]/this.cnt[r]
    })
    this.dirty = true
  }

  // return the time series for a specific range in the form of [[time], [value]]
  // returns a time series such that the last point covers `at`
  get(range, at=Date.now()) {
    const ix = TimeSeries.ranges.indexOf(range)
    if (ix < 0) return []
    const t0 = this.t0[range]
    const interval = TimeSeries.intervals[ix]
    const limit = TimeSeries.limits[ix]
    const start = (Math.trunc(at/interval) - limit + 1)*interval // start of time-series to return
    const times = Array(limit).fill(0).map((_,i)=>start+i*interval)
    let values
    const offset = (start-t0)/interval
    if (offset >= 0) {
      values = this.data[range].slice(offset, offset+limit)
      if (values.length < limit) values = values.concat(Array(limit-values.length).fill(null))
    } else if (-offset < limit) {
      values = Array(-offset).fill(null).concat(this.data[range].slice(0, limit+offset))
    } else {
      values = Array(limit).fill(null)
    }
    if (values.length != limit) throw(`TimeSeries: bad length (got ${values.length}, expected ${limit}, range ${range})`)
    return [times, values]
  }

  // save the time series to the filesystem
  save(cb) {
    if (!this.dirty) return

    this.dirty = false // assume it will work, avoid race conditions
    const data = {data: this.data, t0: this.t0, sum: this.sum, cnt: this.cnt}
    //console.log("TimeSeries: saving", this.path)
    const json = JSON.stringify(data)
    if (json.length < 100) {
      // there have been issues with zero-length time series files being written, see whether this helps
      const err = `TimeSeries: error saving ${this.path}, json too short <<${json}>>`
      console.log(err)
      if (cb) cb(err)
      return
    }
    const fname = this.path + "-" + cnt++
    fs.writeFile(fname, json, err => {
      if (err) {
        this.dirty = true // "oops"... try again later
        console.log("TimeSeries: error writing", this.path, err)
      } else {
        fs.rename(fname, this.path, ()=>{
          // console.log("TimeSeries: saved", this.path)
        })
      }
      if (cb) cb(err)
    })
  }

  // load the time series from the filesystem
  load() {
    try {
      var raw = fs.readFileSync(this.path).toString()
    } catch (err) {
      if (err.code != 'ENOENT') {
        console.log("TimeSeries: error reading", this.path, err)
      } else console.log(`Missing time series ${this.path}`)
      // no file: create empty time series
      this.clear(Date.now())
      return
    }
    // parse data
    try {
      const {data, t0, sum, cnt} = JSON.parse(raw)
      this.data = data
      this.t0 = t0
      this.sum = sum
      this.cnt = cnt

      console.log(`TimeSeries: loaded ${this.path}`)
      // print debug info
      if (0) {
        for (const r in data) {
          const start = new Date(t0[r]).toISOString().replace(/\..*/, '')
          const intv = TimeSeries.intervals[TimeSeries.ranges.indexOf(r)] ?? 0
          let first = data[r].findIndex(v => v != null)
          let last = data[r].findLastIndex(v => v != null)
          if (first >= 0) first = new Date(t0[r] + (first * intv)).toISOString().replace(/\..*/, '')
          if (last >= 0) last = new Date(t0[r] + (last * intv)).toISOString().replace(/\..*/, '')
          const name = (r+"     ").slice(0,5)
          console.log(`  ${name}: t0=${start} -- data: ${first} .. ${last}`)
        }
      }

    } catch (err) {
      console.log("TimeSeries: error parsing", this.path, err)
      console.log("Raw: <<<", raw, ">>>")
      // create empty time series so we can move on
      this.clear(Date.now())
    }
  }
}

module.exports = TimeSeries
