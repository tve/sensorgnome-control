// timeseries - Store simple event time-series
// Copyright ©2023 Thorsten von Eicken, see LICENSE

const path = require('path')
const fs = require('fs')

class TimeSeries {
  static ranges = ['5mins', '4hours', 'day', 'month', 'year']
  static intervals = [10000, 10*60*1000, 3600*1000, 24*3600*1000, 7*24*3600*1000] // 10min, 1h, 1d, 1w
  static limits = [5*6, 4*6, 25, 32, 53] // number of samples to keep
  
  constructor(dir, name) {
    this.name = name
    this.dirty = false
    this.dir = dir
    this.load(dir)
    // this.data[range][limit] = array of event counts (ints) for each range
    // this.t0[range] = time of first sample
    // this.sum[range] = for avg: sum of values going into last last
    // this.cnt[range] = for avg: number of values going into last last
  }

  close() {
    if (this.dirty) this.save(this.dir)
  }

  // clear the time series such that the last point covers time `at`
  clear(at) {
    if (!this.data) {
      this.data = {}
      this.t0 = {}
      this.sum = {}
      this.cnt = {}
    }

    TimeSeries.ranges.forEach((r, i) => {
      const interval = TimeSeries.intervals[i]
      const tLast = Math.trunc(at/interval)*interval
      const t0 = tLast - (TimeSeries.limits[i]-1)*interval
      this.data[r] = Array(TimeSeries.limits[i]).fill(null)
      this.t0[r] = t0
      this.sum[r] = 0
      this.cnt[r] = 0
    })
    this.dirty = true
  }

  // ensure the last lement in the time series covers time `at`
  catch_up(at, fill) {
    if (!'data' in this) {
      throw new Error("EventSeries: not initialized " + this.name)
    }
    if (at > Date.now()+60000)
      throw new Error(`EventSeries: can't insert data into the future, ${this.name}, ${at}, ${Date.now()}`)
    if (fill === undefined) fill = 0

    TimeSeries.ranges.forEach((r, i) => {
      const interval = TimeSeries.intervals[i]
      const limit = TimeSeries.limits[i]
      if (this.data[r].length != limit)
        throw new Error(`EventSeries: ${this.name} ${r} length mismatch ${this.data[r].length} != ${limit}`)

      let tLast = this.t0[r] + (limit-1)*interval
      let offset = Math.floor((at-tLast)/interval)

      if (offset > limit) {
        // too far in the future, clear the data
        this.clear(at)
        return
      }  

      if (offset < 0) {
        // can't insert data into the past
        throw new Error(`EventSeries: can't insert data into the past: ` +
          `${this.name} ${r} at=${at} last=${tLast} offset=${offset} ival=${interval} now=${Date.now()}`)
      }

      if (offset > 0) {
        // add null samples to catch up
        this.data[r] = this.data[r].slice(offset).concat(Array(offset).fill(fill))
        this.t0[r] += offset*interval
        this.sum[r] = 0
        this.cnt[r] = 0
        //this.dirty = true
      }
    })
  }

  // add a new event to the time series
  // at: Date().now timestamp; n: number of events to add (typ. 1)
  add(at, n) {
    this.catch_up(at)
    TimeSeries.ranges.forEach((r, i) => {
      this.data[r][TimeSeries.limits[i]-1] += n
    })
    this.dirty = true
  }

  // average a new value into the time series
  avg(at, v) {
    this.catch_up(at, null)
    TimeSeries.ranges.forEach((r, i) => {
      this.sum[r] += v
      this.cnt[r] += 1
      const d = this.data[r]
      const limit = TimeSeries.limits[i]
      d[limit-1] = this.sum[r]/this.cnt[r]
    })
    this.dirty = true
  }

  // return the time series for a specific range in the form of [[time], [value]]
  // returns a time series such that the lat point covers `at`
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
    if (values.length != limit) throw(`EventSeries: bad length (got ${values.length}, expected ${limit}, range ${range})`)
    return [times, values]
  }

  // save the time series to the filesystem
  save() {
    if (!this.dirty) return

    const file = path.join(this.dir, this.name+'.json')
    this.dirty = false // assume it will work, avoid race conditions
    const data = {data: this.data, t0: this.t0, sum: this.sum, cnt: this.cnt}
    fs.writeFile(file, JSON.stringify(data), err => {
      if (err) {
        this.dirty = true // "oops"... try again later
        console.log("EventSeries: error writing", file, err)
      }
    })
  }

  // load the time series from the filesystem
  load(dir) {
    const file = path.join(dir, this.name+'.json')
    try {
      var raw = fs.readFileSync(file)
    } catch (err) {
      if (err.code != 'ENOENT') {
        console.log("EventSeries: error reading", file, err)
      } else console.log("Empty time series", file)
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
    } catch (err) {
      console.log("EventSeries: error parsing", file, err)
    }
  }
}

module.exports = TimeSeries