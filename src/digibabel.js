// digibabel - manage DigiBabel UHF FSK tag receivers

//   operate a DigiBabel tag receiver

//   This object represents a plugged-in DigiBabel receiver. As soon as it
//   is created, it begins recording tag detections. The device reports detections
//   via an FTDI FT230X USB serial adapter (VID=0403, PID=6015) running at 230400 bps.babel - manage DigiBabel UHF FSK tag receivers

//   operate a DigiBabel tag receiver

//   This object represents a plugged-in DigiBabel receiver. As soon as it
//   is created, it begins recording tag detections. The device reports detections
//   via an FTDI FT232 USB serial adapter running at 230400 bps.
//   
//   The protocol uses a framed format:
//     START_FLAG (0x3C '<') | LENGTH (1 byte) | MESSAGE_CODE | COMMAND_CODE | 
//     OPERATION_CODE | PAYLOAD (N bytes) | CRC16 (2 bytes, MSB first) | STOP_FLAG (0x3E '>')
//
//   Tag detections have COMMAND_CODE = 0x82 and contain one of two payload schemas:
//
//     New schema (payload length 6 bytes):
//       - Bytes 0-3: Tag ID (4 bytes)
//       - Byte 4: Embedded CRC byte
//       - Byte 5: RSSI (raw 0-255 value)
//
//     Old schema (payload length 5 bytes):
//       - Bytes 0-3: Tag ID (4 bytes)
//       - Byte 4: RSSI (raw 0-255 value)
//
//   This module watches for such frames, and emits gotTag events of the form:
//       T[0-9]{1,2},<TS>,<ID>,<RSSI>,<valid>\n
//   where the number after 'T' is the USB port #, <TS> is the timestamp in seconds,
//   <ID> is the 8-hex digit tag ID. <RSSI> is the RSSI value in dB.
//   <valid> is:
//     1 when the embedded CRC matches a CRC-8 over the tag ID bytes
//       (width=8, poly=0x07, init=0x00),
//     0 when the embedded CRC does not match (new 6-byte schema),
//    -1 for old 5-byte schema detections that carry no embedded CRC.

const {SerialPort} = require('serialport')

let didEnum = false
let debugId = 1

// Debug switch: set to true to log every raw received serial chunk as hex.
const DEBUG_RAW_HEX = false

// Protocol constants
const START_FLAG = 0x3C  // '<'
const STOP_FLAG = 0x3E   // '>'
const TAG_DETECTION_CMD = 0x82
// Bytes to enable detection forwarding from the digibabel
const DET_ON_CODE = 0x00 // Message code
const DET_ON_CMD = 0x0C // Command code
const DET_ON_OP = 0x00 // Operation code
const DET_ON_PL = 0x0001 // Payload length
// Bytes to disable LED blinking during detections (Lotek notes that LED blinking can reduce the max detection rate)
const LED_OFF_CODE = 0x00 // Message code
const LED_OFF_CMD = 0x0D // Command code
const LED_OFF_OP = 0x00 // Operation code
const LED_OFF_PL = 0x0001 // Payload length
const CMD_REQ_PAYLOAD = 0x01
const DET_ON_ACK_PAYLOAD = 0xFE
const LED_OFF_ACK_PAYLOAD = 0xFF
const CMD_ACK_TIMEOUT_MS = 2000

// CRC-16-CCITT (False) implementation
// Polynomial: 0x1021, init varies, RefIn/RefOut: False, XorOut: 0x0000
const POLY16 = 0x1021

// CRC-8 implementation
// Polynomial: 0x07, init=0x00, refin/refout=false, xorout=0x00
const POLY8 = 0x07

function calcIncrCrc16(bNext, uInit) {
  // Incrementally update CRC16 with a single next byte.
  let uCrc = uInit & 0xFFFF
  let uTemp = (bNext & 0xFF) << 8
  uCrc ^= uTemp
  for (let i = 0; i < 8; i++) {
    if ((uCrc & 0x8000) !== 0) {
      uCrc = ((uCrc << 1) ^ POLY16) & 0xFFFF
    } else {
      uCrc = (uCrc << 1) & 0xFFFF
    }
  }
  return uCrc & 0xFFFF
}

function calcCrc16(data, offset, uInit) {
  // Compute CRC16 over a byte buffer from offset to end.
  let uCrc = uInit & 0xFFFF
  for (let i = offset; i < data.length; i++) {
    uCrc = calcIncrCrc16(data[i], uCrc)
  }
  // Lotek CRCs are little endian - swap bytes
  const msb = (uCrc >> 8) & 0xFF
  const lsb = uCrc & 0xFF
  return ((lsb << 8) | msb) & 0xFFFF
}

function calcCrc8(data, offset, initValue) {
  // Compute CRC8 over a byte buffer from offset to end.
  let crc = (initValue ?? 0x00) & 0xFF
  for (let i = offset ?? 0; i < data.length; i++) {
    crc ^= data[i] & 0xFF
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x80) !== 0) {
        crc = ((crc << 1) ^ POLY8) & 0xFF
      } else {
        crc = (crc << 1) & 0xFF
      }
    }
  }
  return crc & 0xFF
}

function hamming74ErrorCorrection(codeword) {
  // Correct a single-bit error in a Hamming(7,4) codeword and report whether correction was applied.
  // Hamming(7,4): use only the lower 7 bits of each received byte.
  const b = codeword & 0x7F
  const bits = new Array(7)
  for (let i = 0; i < 7; i++) {
    bits[i] = (b >> i) & 0x01
  }

  // Syndrome bits from parity-check rows:
  // s0: [1,0,1,0,1,0,1], s1: [0,1,1,0,0,1,1], s2: [0,0,0,1,1,1,1]
  const s0 = (bits[0] ^ bits[2] ^ bits[4] ^ bits[6]) & 0x01
  const s1 = (bits[1] ^ bits[2] ^ bits[5] ^ bits[6]) & 0x01
  const s2 = (bits[3] ^ bits[4] ^ bits[5] ^ bits[6]) & 0x01
  const syndrome = (s2 << 2) | (s1 << 1) | s0

  let corrected = false
  if (syndrome !== 0) {
    const errorPos = syndrome - 1
    if (errorPos < 7) {
      bits[errorPos] ^= 0x01
      corrected = true
    }
  }

  let correctedCodeword = 0
  for (let i = 0; i < 7; i++) {
    correctedCodeword |= (bits[i] & 0x01) << i
  }

  return { correctedCodeword: correctedCodeword & 0x7F, corrected }
}

function crcInitFromPayloadLength(length) {
  // The USB CRC init depends on the payload length in this way: 0x{length}00.
  return ((length & 0xFF) << 8) & 0xFFFF
}

function buildFrame(messageCode, commandCode, operationCode, payload) {
  // Build a complete framed DigiBabel command with CRC and delimiters.
  const N = payload.length
  if (N > 255) {
    throw new Error('Payload length must be <= 255')
  }
  
  const head = Buffer.from([N, messageCode, commandCode, operationCode])
  const core = Buffer.concat([head, payload])
  const crc = calcCrc16(core, 0, crcInitFromPayloadLength(N))
  
  return Buffer.concat([
    Buffer.from([START_FLAG]),
    core,
    Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF]),
    Buffer.from([STOP_FLAG])
  ])
}

class DigiBabel {
  // Initialize a receiver instance and open its serial stream immediately.
  constructor(matron, dev, options) {
    if (!didEnum) this.enum()

    this.matron = matron
    this.dev = dev
    this.options = options ?? {}
    this.debugRawHex = !!(this.options.debugRawHex ?? this.options.debug_raw_hex ?? DEBUG_RAW_HEX)
    this.sp = null // opened serial device
    this.buffer = Buffer.alloc(0) // buffer for incoming data
    this.retries = 0 // number of retries opening the device
    this.initialized = false // whether init messages have been sent
    this.pendingControlAck = null // pending control-command acknowledgement waiter

    this.matron.on("devRemoved", (dev) => this.devRemoved(dev))

    this.init_sp()
  }

  getPort() {
    // Resolve current USB port number safely for logs/state updates.
    return this.dev?.attr?.port ?? '?'
  }

  getPath() {
    // Resolve current device path safely for logs after unplug events.
    return this.dev?.path ?? '<removed>'
  }

  // enumerate serial ports for debugging purposes
  enum() {
    didEnum = true
    SerialPort.list().then((list) => {
      list.forEach((port) => {
        console.log("SerialPort: " + JSON.stringify(port) + "\n")
      })
    })
  }

  close() {
    // Close and detach the serial stream for this receiver instance.
    if (this.sp) {
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
      console.log("Removed " + this.getPath())
    }
  }

  devRemoved(dev) {
    // React only to removal of this specific device and clear local handle.
    if (!this.dev || dev.path != this.dev.path) return
    this.close()
    this.dev = null
  }

  init_sp() {
    // Open the serial device and install event handlers for lifecycle and frame input.
    if (!this.dev) return // device removed
    this.matron.emit("devState", this.dev.attr.port, "init")
    const path = this.dev.path
    const sp = new SerialPort({ 
      path: path, 
      baudRate: 230400,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    const did = debugId++
    
    sp.on("open", () => {
      console.log(`Opened DigiBabel SerialPort #${did} ${path}`)
      // Send initialization messages after a short delay
      setTimeout(() => this.sendInitMessages(), 1000)
    })
    
    sp.on("close", () => {
      console.log(`DigiBabel SerialPort #${did} ${path} was closed`)
      if (this.dev && !this.dev.state?.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", "port was closed")
    })
    
    sp.on("error", err => {
      console.log(`Error on DigiBabel SerialPort #${did} ${path}: ${err.message}\nStack: ${err.stack}`)
      if (this.dev && !this.dev.state?.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", err.message)
      if (sp.isOpen) sp.close()
      if (this.retries++ < 3) {
        setTimeout(() => {
          this.init_sp()
        }, this.retries < 3 ? 10000 : 60000)
      }
    })
    
    // Hook up data parser
    sp.on("data", data => {
      if (this.debugRawHex) {
        const port = this.dev?.attr?.port ?? '?'
        const ts = (Date.now() / 1000).toFixed(3)
        console.log(`DigiBabel raw rx port ${port} ts=${ts} len=${data.length} hex=${data.toString('hex')}`)
      }
      this.buffer = Buffer.concat([this.buffer, data])
      this.processBuffer()
    })
    
    this.sp = sp
    console.log("Starting DigiBabel read stream using SerialPort at", path)
  }

  sendControlFrame(messageCode, commandCode, operationCode, payloadByte, expectedAckPayload, label) {
    // Send one control command and resolve only after a matching protocol-level acknowledgement arrives.
    if (!this.dev || !this.sp || !this.sp.isOpen) {
      return Promise.reject(new Error(`Cannot send ${label}: serial port not open`))
    }

    if (this.pendingControlAck) {
      return Promise.reject(new Error(`Cannot send ${label}: another control acknowledgement is pending`))
    }

    const data = buildFrame(messageCode, commandCode, operationCode, Buffer.from([payloadByte]))
    if (this.debugRawHex) {
      const port = this.getPort()
      const ts = (Date.now() / 1000).toFixed(3)
      console.log(`DigiBabel raw tx port ${port} ts=${ts} len=${data.length} hex=${data.toString('hex')}`)
    }

    return new Promise((resolve, reject) => {
      // Start an acknowledgement timeout so init cannot hang indefinitely.
      const timeout = setTimeout(() => {
        if (this.pendingControlAck?.label !== label) return
        this.pendingControlAck = null
        reject(new Error(`Timed out waiting for ${label} acknowledgement`))
      }, CMD_ACK_TIMEOUT_MS)

      // Track the expected response shape to match in parseFrame().
      this.pendingControlAck = {
        label,
        messageCode,
        commandCode,
        operationCode,
        expectedAckPayload,
        resolve,
        reject,
        timeout,
      }

      // Write request frame to the serial port; acknowledgement is handled asynchronously from input frames.
      this.sp.write(data, (err) => {
        if (!this.dev) {
          if (this.pendingControlAck?.label === label) {
            clearTimeout(timeout)
            this.pendingControlAck = null
          }
          reject(new Error(`Cannot complete ${label}: device removed`))
          return
        }

        if (err) {
          if (this.pendingControlAck?.label === label) {
            clearTimeout(timeout)
            this.pendingControlAck = null
          }
          console.log(`Error writing ${label} message to ${this.getPath()}: ${err}`)
          reject(err)
          return
        }

        console.log(`Sent DigiBabel ${label} message to port ${this.getPort()}, waiting for ack`)
      })
    })
  }

  handleControlAck(frameMessageCode, frameCommandCode, frameOperationCode, payload) {
    // Match an incoming non-tag response against the currently pending command acknowledgement.
    const pending = this.pendingControlAck
    if (!pending) return false

    if (frameMessageCode !== pending.messageCode ||
        frameCommandCode !== pending.commandCode ||
        frameOperationCode !== pending.operationCode) {
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingControlAck = null

    if (payload.length === 1 && payload[0] === pending.expectedAckPayload) {
      console.log(`Received DigiBabel ack for ${pending.label} on port ${this.getPort()}`)
      pending.resolve()
    } else {
      const payloadHex = payload.toString('hex')
      const expectedHex = pending.expectedAckPayload.toString(16).padStart(2, '0')
      const err = new Error(`Unexpected ack payload for ${pending.label}: ${payloadHex} (expected ${expectedHex})`)
      console.log(err.message)
      pending.reject(err)
    }
    return true
  }

  sendInitMessages() {
    // Run startup command sequence and transition device state to running only after both ACKs succeed.
    if (!this.sp || !this.sp.isOpen) return
    
    try {
      // Send initialization messages in order:
      // 1) Disable LED blinking
      // 2) Enable detection forwarding
      setTimeout(() => {
        if (!this.dev || !this.sp || !this.sp.isOpen) return
        ;(async () => {
          try {
            // Keep startup ordering explicit: LED behavior first, then detection forwarding.
            await this.sendControlFrame(LED_OFF_CODE, LED_OFF_CMD, LED_OFF_OP, CMD_REQ_PAYLOAD, LED_OFF_ACK_PAYLOAD, 'LED disable')
            await this.sendControlFrame(DET_ON_CODE, DET_ON_CMD, DET_ON_OP, CMD_REQ_PAYLOAD, DET_ON_ACK_PAYLOAD, 'detection forwarding enable')

            if (!this.dev) return
            const port = this.getPort()
            this.initialized = true
            this.matron.emit("devState", port, "running")
          } catch (initErr) {
            if (!this.dev || this.dev.state?.startsWith("err")) return
            const msg = `DigiBabel init failed: ${initErr.message}`
            console.log(msg)
            this.matron.emit("devState", this.getPort(), "error", msg)
          }
        })()
      }, 100)
    } catch (err) {
      console.log(`Error building init messages: ${err.message}`)
    }
  }

  processBuffer() {
    // Incrementally parse framed protocol data from a rolling serial buffer.
    while (true) {
      // Look for start flag
      const startIdx = this.buffer.indexOf(START_FLAG)
      if (startIdx === -1) {
        // No start flag found, clear buffer (keep last byte in case it's a partial start)
        if (this.buffer.length > 1) {
          this.buffer = this.buffer.slice(-1)
        }
        break
      }
      
      // Discard any data before the start flag
      if (startIdx > 0) {
        this.buffer = this.buffer.slice(startIdx)
      }
      
      // Check if we have enough data for the header (1 start + 4 header bytes)
      if (this.buffer.length < 5) {
        break // Need more data
      }
      
      // Parse header
      const length = this.buffer[1]
      const messageCode = this.buffer[2]
      const commandCode = this.buffer[3]
      const operationCode = this.buffer[4]
      
      // Calculate total frame length: start(1) + header(4) + payload(length) + crc(2) + stop(1)
      const frameLength = 1 + 4 + length + 2 + 1
      
      if (this.buffer.length < frameLength) {
        break // Need more data
      }
      
      // Extract the complete frame
      const frame = this.buffer.slice(0, frameLength)

      // Parse frame before consuming it; on invalid frame, advance only one byte to resync.
      const ok = this.parseFrame(frame, length, messageCode, commandCode, operationCode)
      this.buffer = this.buffer.slice(ok ? frameLength : 1)
    }
  }

  parseFrame(frame, length, messageCode, commandCode, operationCode) {
    // Validate one complete frame and dispatch either ACK responses or tag detections.
    const port = this.getPort()

    // Validate stop flag
    if (frame[frame.length - 1] !== STOP_FLAG) {
      console.log(`Invalid stop flag in DigiBabel frame on port ${port}; attempting resync`)
      return false
    }
    
    // Extract payload and CRC
    const payload = frame.slice(5, 5 + length)
    const crcBytes = frame.slice(5 + length, 5 + length + 2)
    const crcReceived = (crcBytes[0] << 8) | crcBytes[1]
    
    // Compute CRC over header + payload using init=0x{payloadLength}00
    const core = frame.slice(1, 5 + length)
    const crcComputed = calcCrc16(core, 0, crcInitFromPayloadLength(length))
    
    if (crcReceived !== crcComputed) {
      if (commandCode === TAG_DETECTION_CMD) {
        // USB-level CRC failed, so this detection is ignored and never emitted as gotTag.
        console.log(`Discarded DigiBabel detection on port ${port} due to USB CRC mismatch: ` +
                    `received 0x${crcReceived.toString(16)}, computed 0x${crcComputed.toString(16)}, core=${core.toString('hex')}`)
      } else {
        console.log(`CRC mismatch in DigiBabel frame on port ${port}: ` +
                    `received 0x${crcReceived.toString(16)}, computed 0x${crcComputed.toString(16)}, core=${core.toString('hex')}`)
      }
      return false
    }

    // Resolve any in-flight control-command acknowledgement before generic handling.
    if (this.handleControlAck(messageCode, commandCode, operationCode, payload)) {
      return true
    }
    
    // Process based on command code
    if (commandCode === TAG_DETECTION_CMD) {
      this.handleTagDetection(payload)
    } else {
      // Other command responses (could be init responses, status, etc.)
      console.log(`DigiBabel response on port ${port}: ` +
                  `cmd=0x${commandCode.toString(16).padStart(2, '0')}, ` +
                  `op=0x${operationCode.toString(16).padStart(2, '0')}, ` +
                  `payload=${payload.toString('hex')}`)
    }

    return true
  }

  handleTagDetection(payload) {
    // Decode a tag-detection payload, validate/correct ID bits, and emit the normalized gotTag record.
    if (!this.dev) return
    const port = this.getPort()

    // Old payload is 5 bytes; new payload is 6 bytes.
    if (payload.length < 5) {
      console.log(`Invalid tag detection payload length on port ${port}: ${payload.length}`)
      return
    }
    
    // Extract original Tag ID bytes (bytes 0-3).
    const tagOnlyOriginal = Buffer.from(payload.slice(0, 4))
    let tagOnlyForRecord = tagOnlyOriginal

    // New schema includes an embedded CRC byte at payload[4] and moves RSSI to payload[5].
    // Old schema has RSSI at payload[4] and provides no embedded CRC.
    let valid = 0
    let rssiRaw
    if (payload.length >= 6) {
      const embeddedCrcReceived = payload[4] & 0xFF

      // Apply Hamming(7,4) correction to each Tag ID byte before CRC validation.
      const tagOnlyCorrected = Buffer.from(tagOnlyOriginal)
      const hammingCorrections = []
      for (let i = 0; i < 4; i++) {
        const originalByte = tagOnlyOriginal[i]
        const { correctedCodeword, corrected } = hamming74ErrorCorrection(originalByte)
        tagOnlyCorrected[i] = correctedCodeword
        if (corrected) {
          hammingCorrections.push(`byte[${i}] 0x${originalByte.toString(16).padStart(2, '0')}->0x${correctedCodeword.toString(16).padStart(2, '0')}`)
        }
      }
      if (hammingCorrections.length > 0) {
        console.log(`DigiBabel Hamming correction on port ${port}: ${hammingCorrections.join(', ')}`)
      }

      // The embedded CRC is a CRC-8 over the corrected TagID bytes.
      const embeddedCrcComputed8 = calcCrc8(tagOnlyCorrected, 0, 0x00)
      valid = (embeddedCrcReceived === embeddedCrcComputed8) ? 1 : 0

      // If corrected Tag ID fails CRC, keep the originally received Tag ID in output.
      if (valid === 1) {
        tagOnlyForRecord = tagOnlyCorrected
      } else {
        tagOnlyForRecord = tagOnlyOriginal
      }

      rssiRaw = payload[5]
    } else {
      // Old schema: no embedded CRC byte.
      valid = -1
      tagOnlyForRecord = tagOnlyOriginal
      rssiRaw = payload[4]
    }

    const tagId = tagOnlyForRecord.toString('hex')
    
    let rssiDb
    if (rssiRaw > 0) {
      rssiDb = -rssiRaw / 2 // Formula provided by Lotek
    } else {
      rssiDb = -Infinity
    }
    
    // Get current timestamp in seconds
    const nowSecs = Date.now() / 1000
    
    // Build the record in the expected format: T<port>,<timestamp>,<tagid>,<rssi>,<valid>
    const lifetagRecord = `T${port},${nowSecs},${tagId},${rssiDb.toFixed(1)},${valid}`
    
    // Emit the gotTag event
    this.matron.emit("gotTag", lifetagRecord)
    
    // Write to the LifeTag output stream (CTT format)
    if (typeof LifetagOut !== 'undefined') {
      LifetagOut.write(lifetagRecord + "\n")
    }
    
    console.log(`DigiBabel tag: ${lifetagRecord}`)
  }
}

module.exports = DigiBabel
