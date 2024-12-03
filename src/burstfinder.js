// code to find pulse bursts

// Tag definitions are global in this module. This means there is one global search tree.
// The FindBursts class is for one port, so one instance per port is required.
// The config settings are also global.

// default config parameters to match pulses, taken from the way tag-finder is run on Sensorgnomes
const config = {
  FREQ_SLOP: 0.1,  // freq range (kHz) for a burst
  FREQ_OUTLIER: true, // allow one frequency outlier true/false
  SIGNAL_SLOP: 20, // signal range (dB) for a burst
  TIME_SLOP: 15, // max time diff from measured interval in 1/10th ms
  MAX_BURST_TIME: 3*160 + 10, // max time a burst can take in ms, used to discard older pulses
}

const default_out = {
  raw: true,
  filtered: false,
  delta: false,
  burst: false,
}

// parameters for Jeff's burstfinder
// MAX_PULSE_SLOP = 0.0015 # [s] Max variation in pulse intervals for matching a burst to a code
// MAX_FREQ_DIFF = 0.1 # [kHz] Max difference between max and min frequency of pulses within a burst
// MAX_FREQ_OUTLIERS = 1 # [] Max number of pulses that are allowed to be outside of the max frequency range (usually required to include pulses from other bursts)
// MAX_USED_PULSES = 1 # [] Max number of pulses that can be used in more than one burst
// MAX_SIG_DIFF = 20 # [dB] Max difference between max and min signal strength of pulses within a burst

// Each tag definition (3 intervals) is turned into a search tree with a TreeNode for each level
// The root node holds children for each possible last interval (last because the search is done
// backwards when the last pulse is received).
// Each of those child nodes holds further nodes for the middle interval.
// The third level holds TagNodes that represent decoded tags.
class TreeNode {
  constructor() { this.children = {}; this.max_iv = 0; }

  // compatible returns true if the new pulse is compatible with the pulses so far in terms of
  // frequency and signal strength
  compatible(p, suffix) {
    for (const p2 of suffix) {
      // if (Math.abs(p2.freq - p.freq) > FREQ_SLOP) return false
      if (Math.abs(p2.sig - p.sig) > config.SIGNAL_SLOP) return false
    }
    // allow freq_slop plus one outlier
    const freqs = [...suffix.map(s=>s.freq), p.freq].sort((a,b)=>a-b)
    const len = freqs.length
    if (config.FREQ_OUTLIER) {
      if (len <= 2) return true // given that we allow one outlier...
      const ok = freqs[len-2] - freqs[0] <= config.FREQ_SLOP || freqs[len-1] - freqs[1] <= config.FREQ_SLOP
      // if (len == 4) console.log(ok, freqs, Array.isArray(freqs))
      return ok
    } else {
      return freqs[len-1] - freqs[0] <= config.FREQ_SLOP
    }
  }

  // add a tag with the specified intervals left and the tag id
  // the intervals are specified "forwards" in time order, and add() pops off the last one
  add(intervals, tagid) {
    const iv = intervals.pop()
    if (iv > this.max_iv) this.max_iv = iv
    if (intervals.length == 0) {
      // no more intervals past this, so child needs to be a TagNode
      if (iv in this.children) {
        if (this.children[iv].tagid != tagid) console.log("Oops, duplicate!", tagid)
      } else {
        this.children[iv] = new TagNode(tagid)
      }
    } else {
      if (!(iv in this.children)) this.children[iv] = new TreeNode()
      this.children[iv].add(intervals, tagid)
    }
  }

  // try to match all history pulses against the intervals we have tags for
  // ix is the index into the history where to start searching
  match(history, ix, suffix) {
    const s0 = suffix[0] // oldest pulse so far
    for (; ix<history.length; ix++) {
      const p = history[ix]
      const dt = Math.round((s0.ts - p.ts)*10) // in 1/10th ms
      if (dt - config.TIME_SLOP > this.max_iv+1) return // nothing past this can match anymore
      if (!this.compatible(p, suffix)) continue
      for (let iv = Math.ceil(dt-config.TIME_SLOP); iv <= Math.floor(dt+config.TIME_SLOP); iv += 1) {
        if (iv in this.children) {
          const s = ([p]).concat(suffix)
          this.children[iv].match(history, ix+1, s)
        }
      }  
    }
  }
}

// A TagNode represents the endpoint of a match and corresponds to a unique tag
class TagNode {
  static cb = undefined // callback when burst found

  constructor(tagid) { this.tagid = tagid }

  match(history, ix, suffix) {
    if (suffix.length != 4) {
      console.log("Oops, burstlen != 4", suffix.length, suffix, this.tagid)
    } else {
      const s0 = suffix[0]
      const s1 = suffix[1]
      const s2 = suffix[2]
      const s3 = suffix[3]
      const intv = [ s1.ts-s0.ts, s2.ts-s1.ts, s3.ts-s2.ts ]
      const info = [ s0.port, s0.ts/1000, this.tagid, ...intv, ...tags[this.tagid] ]
      for (const s of suffix) s.keep = true
      if (TagNode.cb) TagNode.cb(info, suffix)
    }
  }
}

// global tag definitions and resulting search tree

const tags = {}
const tree = new TreeNode()
let tagCount = 0;

function addTagDef(intervals, tagid) { // intervals is an array in millisecs
  if (!(tagid in tags)) {
    tree.add(intervals.concat(), tagid)
    tags[tagid] = intervals
    tagCount++
  }
}

// callback when a burst is found, this is global (not great abstraction, but works...)
let pulseCB
function setCallbacks(burstCB, pulseCB_) { pulseCB = pulseCB_; TagNode.cb = burstCB }

class FindBursts {
  history = [] // array of pulses, most recent first
  lastPulse = 0 // timestamp of last pulse flushed, used to print deltas
  tagCount = 0

  static arrayMeanStddev(array) {
    if (!Array.isArray(array) || array.length == 0) return undefined
    let mean = 0
    for (const v of array) mean += v
    mean /= array.length
    let variance = 0
    for (const v of array) variance += (v-mean)*(v-mean)
    variance /= array.length
    return [mean, Math.sqrt(variance)]
  }

  // prune the history of pulses, eliminating those that are too old to fit into any burst
  // note that history is ordered most recent first
  pruneHistory(ts) {
    let deadline = ts - config.MAX_BURST_TIME
    let ix = this.history.findIndex(e => e.ts < deadline)
    if (ix >= 0) {
      for (let i=this.history.length-1; i>=ix; i--) {
        const pls = this.history[i]
        if (pls.keep && pulseCB) pulseCB(pls)
          // let dt = pls.ts - lastPulse[port]
          // dt = dt < 1 ? `,${(dt*1000).toFixed(0)}ms` : ""
          // if (pulseCB) pulseCB(pls)
          // console.log(`P${port},${(pls.ts/1000).toFixed(4)},` + 
          //   `${pls.freq.toFixed(1)},${pls.sig.toFixed(0)},${pls.noise.toFixed(0)}` // ${dt}`
          // )
          // lastPulse[port] = pls.ts
        // }
      }
      this.history.splice(ix) // delete starting at ix
    }
  }

  addPulse(pulse) { // pulse: port,ts,freq,sig,noise,snr
    pulse.keep = false
    this.pruneHistory(pulse.ts)
    tree.match(this.history, 0, [pulse])
    this.history.unshift(pulse)
  }

  flushPulses() { this.pruneHistory(Number.POSITIVE_INFINITY) }
}

// ===== Burst finder "main" that plugs into sg-control

// parse a pulse line
function parsePulse(line) {
  const ll = line.split(',')
  if (ll.length < 6) console.log("Ooops, bad line", line)
  return {
    port: ll[0].slice(1),
    ts: parseFloat(ll[1])*1000,
    freq: parseFloat(ll[2]),
    sig: parseFloat(ll[3]),
    noise: parseFloat(ll[4]),
    snr: parseFloat(ll[5]),
    keep: false,
  }
}

// ===== BurstFinder class used in sg-control

class BurstFinder {
  bf = [] // FindBursts instance per port
  lastTs = 0

  constructor(matron, burstdb) {
    this.matron = matron

    try {
      const text = Fs.readFileSync(burstdb).toString()
      const j = JSON.parse(text)
      let count = 0
      for (const mfgid in j) {
        addTagDef(j[mfgid], mfgid)
        count++
      }
      console.log(`Added ${count} Lotek burst definitions`)
    } catch (e) {
      console.log(`Error adding burst defs from ${burstdb}: ${e}`)
    }

    this.out = { ...default_out, ...(Acquisition.burstfinder || {}) }
    console.log("Burstfinder init: ", JSON.stringify(this.out))
    console.log("Burstfinder init: ", JSON.stringify(Acquisition.burstfinder))
  }

  setOutput(kind, value) {
    if (kind in this.out) {
      this.out[kind] = !!value
      Acquisition.update({burstfinder: {...this.out}}) // clone to force saving
      this.matron.emit("bfOutConfig", this.out)
    }
  }

  gotBurstCB(info, pulses) {
    // info: [ s0.port, s0.ts/1000, this.tagid, ...intv, ...tags[this.tagid] ]
    // pulses: array of 4 pulses with {port,ts,freq,sig,noise,snr} 
    // console.log("b" + info.join(','))
    const [meanFreq, sdFreq] = FindBursts.arrayMeanStddev(pulses.map(s=>s.freq))
    const [meanSig, sdSig] = FindBursts.arrayMeanStddev(pulses.map(s=>s.sig))
    const [meanNoise, sdNoise] = FindBursts.arrayMeanStddev(pulses.map(s=>s.noise))
    const [meanSnr, sdSnr] = FindBursts.arrayMeanStddev(pulses.map(s=>s.snr))
    const text = `B${info[0]},${info[1].toFixed(4)},${info[2]},` +
      `${meanFreq.toFixed(2)},${sdFreq.toFixed(2)},` +
      `${meanSig.toFixed(1)},${sdSig.toFixed(1)},` +
      `${meanNoise.toFixed(1)},` +
      `${meanSnr.toFixed(1)},`
    const burst = { text, info, meanFreq, sdFreq, meanSig, sdSig, meanNoise, meanSnr }
    this.matron.emit("gotBurst", burst)
    if (this.out.burst) this.matron.emit("bfOut", burst)
    // console.log(`       ${pulses.map(s=>(s.ts/1000).toFixed(4)).join(',')}`)
  }

  // FindBurst outputs a pulse that got "used" as part of a burst
  keepPulseCB(pls) {
    // output as filtered pulse
    const text = `P${pls.port},${(pls.ts/1000).toFixed(4)},` + 
      `${pls.freq.toFixed(1)},${pls.sig.toFixed(0)},${pls.noise.toFixed(0)},${pls.snr.toFixed(0)}`
    if (this.out.filtered) this.matron.emit("bfOut", { text })
    const dt = pls.ts - this.lastTs
    this.lastTs = pls.ts
    const delta = `D${pls.port},${dt.toFixed(1)},` + 
      `${pls.freq.toFixed(1)},${pls.sig.toFixed(0)},${pls.noise.toFixed(0)},${pls.snr.toFixed(0)}`
    if (this.out.delta) this.matron.emit("bfOut", { text: delta })
  }

  start() {
    setCallbacks((info, pulses) => this.gotBurstCB(info, pulses), pls => this.keepPulseCB(pls))
    this.matron.emit("bfOutConfig", this.out)
    
    this.matron.on("vahData", line => {
      if (! line.startsWith('p')) return
      const pulse = parsePulse(line) // {port, ts, freq, sig}
      if (!this.bf[pulse.port]) this.bf[pulse.port] = new FindBursts()
      // console.log("Matching", pulse, this.bf[pulse.port].history)
      this.bf[pulse.port].addPulse(pulse)

      if (this.out.raw) this.matron.emit("bfOut", { text: line }) // pass-through of unfiltered pulses
    })

    setInterval(()=>{
      // prune history as of 2 seconds ago (this leaves a bit of slop for events to propagate)
      for (const bfp of this.bf) if (bfp) bfp.pruneHistory(Date.now()-2000)
    }, 5000)
  }

}

module.exports = { BurstFinder }
