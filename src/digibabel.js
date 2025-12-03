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
//   Tag detections have COMMAND_CODE = 0x82 and contain:
//     - Bytes 0-2: Tag ID (3 bytes)
//     - Byte 4: RSSI (raw 0-255 value)
//
//   This module watches for such frames, and emits gotTag events of the form:
//       T[0-9]{1,2},<TS>,<ID>,<RSSI>\n
//   where the number after 'T' is the USB port #, <TS> is the timestamp in seconds,
//   <ID> is the 6-hex digit tag ID, and <RSSI> is the RSSI value in dB.

const {SerialPort} = require('serialport')

let didEnum = false
let debugId = 1

// Protocol constants
const START_FLAG = 0x3C  // '<'
const STOP_FLAG = 0x3E   // '>'
const TAG_DETECTION_CMD = 0x82
const INIT_CMD_1 = 0x0C
const INIT_OP_1 = 0x01
const INIT_CMD_2 = 0x0C
const INIT_OP_2 = 0x00

// CRC-16-CCITT (False) implementation
// Polynomial: 0x1021, Init varies, RefIn/RefOut: False, XorOut: 0x0000
const POLY = 0x1021

function calcIncrCrc16(bNext, uInit) {
  let uCrc = uInit & 0xFFFF
  let uTemp = (bNext & 0xFF) << 8
  uCrc ^= uTemp
  for (let i = 0; i < 8; i++) {
    if ((uCrc & 0x8000) !== 0) {
      uCrc = ((uCrc << 1) ^ POLY) & 0xFFFF
    } else {
      uCrc = (uCrc << 1) & 0xFFFF
    }
  }
  return uCrc & 0xFFFF
}

function calcCrc16(data, offset, uInit) {
  let uCrc = uInit & 0xFFFF
  for (let i = offset; i < data.length; i++) {
    uCrc = calcIncrCrc16(data[i], uCrc)
  }
  // Lotek CRCs are little endian - swap bytes
  const msb = (uCrc >> 8) & 0xFF
  const lsb = uCrc & 0xFF
  return ((lsb << 8) | msb) & 0xFFFF
}

function buildFrame(messageCode, commandCode, operationCode, payload) {
  const N = payload.length
  if (N > 255) {
    throw new Error('Payload length must be <= 255')
  }
  
  const head = Buffer.from([N, messageCode, commandCode, operationCode])
  const core = Buffer.concat([head, payload])
  const crc = calcCrc16(core, 0, 0x0100)
  
  return Buffer.concat([
    Buffer.from([START_FLAG]),
    core,
    Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF]),
    Buffer.from([STOP_FLAG])
  ])
}

class DigiBabel {
  constructor(matron, dev) {
    if (!didEnum) this.enum()

    this.matron = matron
    this.dev = dev
    this.sp = null // opened serial device
    this.buffer = Buffer.alloc(0) // buffer for incoming data
    this.retries = 0 // number of retries opening the device
    this.initialized = false // whether init messages have been sent

    this.matron.on("devRemoved", (dev) => this.devRemoved(dev))

    this.init_sp()
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
    if (this.sp) {
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
      console.log("Removed " + this.dev.path)
    }
  }

  devRemoved(dev) {
    if (!this.dev || dev.path != this.dev.path) return
    this.close()
    this.dev = null
  }

  init_sp() {
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
      this.buffer = Buffer.concat([this.buffer, data])
      this.processBuffer()
    })
    
    this.sp = sp
    console.log("Starting DigiBabel read stream using SerialPort at", path)
  }

  sendInitMessages() {
    if (!this.sp || !this.sp.isOpen) return
    
    try {
      // Send initialization message 1: command 0x0C, operation 0x01, payload 0x00
      const msg1 = buildFrame(0x00, INIT_CMD_1, INIT_OP_1, Buffer.from([0x00]))
      this.sp.write(msg1, (err) => {
        if (err) {
          console.log(`Error writing init message 1 to ${this.dev?.path}: ${err}`)
        } else {
          console.log(`Sent DigiBabel init message 1 to port ${this.dev.attr.port}`)
        }
      })
      
      // Send initialization message 2: command 0x0C, operation 0x00, payload 0x01
      setTimeout(() => {
        const msg2 = buildFrame(0x00, INIT_CMD_2, INIT_OP_2, Buffer.from([0x01]))
        this.sp.write(msg2, (err) => {
          if (err) {
            console.log(`Error writing init message 2 to ${this.dev?.path}: ${err}`)
          } else {
            console.log(`Sent DigiBabel init message 2 to port ${this.dev.attr.port}`)
            this.initialized = true
            this.matron.emit("devState", this.dev.attr.port, "running")
          }
        })
      }, 100)
    } catch (err) {
      console.log(`Error building init messages: ${err.message}`)
    }
  }

  processBuffer() {
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
      this.buffer = this.buffer.slice(frameLength)
      
      // Parse the frame
      this.parseFrame(frame, length, messageCode, commandCode, operationCode)
    }
  }

  parseFrame(frame, length, messageCode, commandCode, operationCode) {
    // Validate stop flag
    if (frame[frame.length - 1] !== STOP_FLAG) {
      console.log(`Invalid stop flag in DigiBabel frame on port ${this.dev.attr.port}`)
      return
    }
    
    // Extract payload and CRC
    const payload = frame.slice(5, 5 + length)
    const crcBytes = frame.slice(5 + length, 5 + length + 2)
    const crcReceived = (crcBytes[0] << 8) | crcBytes[1]
    
    // Compute CRC over header + payload
    const core = frame.slice(1, 5 + length)
    const crcInit = (commandCode === TAG_DETECTION_CMD) ? 0x0500 : 0x0100
    const crcComputed = calcCrc16(core, 0, crcInit)
    
    if (crcReceived !== crcComputed) {
      console.log(`CRC mismatch in DigiBabel frame on port ${this.dev.attr.port}: ` +
                  `received 0x${crcReceived.toString(16)}, computed 0x${crcComputed.toString(16)}`)
      return
    }
    
    // Process based on command code
    if (commandCode === TAG_DETECTION_CMD) {
      this.handleTagDetection(payload)
    } else {
      // Other command responses (could be init responses, status, etc.)
      console.log(`DigiBabel response on port ${this.dev.attr.port}: ` +
                  `cmd=0x${commandCode.toString(16).padStart(2, '0')}, ` +
                  `op=0x${operationCode.toString(16).padStart(2, '0')}, ` +
                  `payload=${payload.toString('hex')}`)
    }
  }

  handleTagDetection(payload) {
    if (payload.length < 5) {
      console.log(`Invalid tag detection payload length on port ${this.dev.attr.port}: ${payload.length}`)
      return
    }
    
    // Extract tag ID (bytes 0-2)
    const tagId = payload.slice(0, 3).toString('hex')
    
    // Extract RSSI (byte 4)
    const rssiRaw = payload[4]
    
    // Convert RSSI to dB: 10 * log10(rssiRaw / 255)
    let rssiDb
    if (rssiRaw > 0) {
      rssiDb = 10 * Math.log10(rssiRaw / 255)
    } else {
      rssiDb = -Infinity
    }
    
    // Get current timestamp in seconds
    const nowSecs = Date.now() / 1000
    
    // Build the record in the expected format: T<port>,<timestamp>,<tagid>,<rssi>
    const lifetagRecord = `T${this.dev.attr.port},${nowSecs},${tagId},${rssiDb.toFixed(2)}`
    
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
