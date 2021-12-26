// Copied and adapted from https://github.com/ethanent/centra to support streaming
// of a post request body.

const path = require('path')
const http = require('http')
const https = require('https')
const qs = require('querystring')
const zlib = require('zlib')
const {URL} = require('url')
const stream = require('stream')
const {promisify} = require('util')
const pipeline = promisify(stream.pipeline);
const crypto = require('crypto')

const supportedCompressions = ['gzip', 'deflate']

class CentraResponse {
	constructor (res, resOptions) {
		this.coreRes = res
		this.resOptions = resOptions

		this.body = Buffer.alloc(0)

		this.headers = res.headers
		this.statusCode = res.statusCode
	}

	_addChunk (chunk) {
		this.body = Buffer.concat([this.body, chunk])
	}

	async json () {
		return this.statusCode === 204 ? null : JSON.parse(this.body)
	}

	async text () {
		return this.body.toString()
	}
}

class CentraRequest {
	constructor (url, method = 'GET') {
		this.url = typeof url === 'string' ? new URL(url) : url
		this.method = method
		this.data = null
		this.sendDataAs = null
		this.reqHeaders = {}
		this.streamEnabled = false
		this.compressionEnabled = false
		this.timeoutTime = null
		this.coreOptions = {}

		this.resOptions = {
			'maxBuffer': 50 * 1000000 // 50 MB
		}

		return this
	}

	query (a1, a2) {
		if (typeof a1 === 'object') {
			Object.keys(a1).forEach((queryKey) => {
				this.url.searchParams.append(queryKey, a1[queryKey])
			})
		}
		else this.url.searchParams.append(a1, a2)

		return this
	}

	path (relativePath) {
		this.url.pathname = path.join(this.url.pathname, relativePath)

		return this
	}

	body (data, sendAs) {
		this.sendDataAs = typeof data === 'object' && !sendAs && !Buffer.isBuffer(data) ? 'json' :
			sendAs ? sendAs.toLowerCase() :
			'buffer'
		this.data = this.sendDataAs === 'form' ? qs.stringify(data) :
			this.sendDataAs === 'json' ? JSON.stringify(data) :
			data

		return this
	}

	header (a1, a2) {
		if (typeof a1 === 'object') {
			Object.keys(a1).forEach((headerName) => {
				this.reqHeaders[headerName.toLowerCase()] = a1[headerName]
			})
		}
		else this.reqHeaders[a1.toLowerCase()] = a2

		return this
	}

	timeout (timeout) {
		this.timeoutTime = timeout
		this.coreOptions['timeout'] = timeout

		return this
	}

	option (name, value) {
		this.coreOptions[name] = value

		return this
	}

	stream () {
		this.streamEnabled = true

		return this
	}

	compress () {
		this.compressionEnabled = true

		if (!this.reqHeaders['accept-encoding']) this.reqHeaders['accept-encoding'] = supportedCompressions.join(', ')

		return this
	}

	send () {
		return new Promise((resolve, reject) => {
			if (this.data) {
				if (this.sendDataAs === 'stream') {
					// this.data.on('error', err => {
				} else {
					if (!this.reqHeaders.hasOwnProperty('content-type')) {
						if (this.sendDataAs === 'json') {
							this.reqHeaders['content-type'] = 'application/json'
						}
						else if (this.sendDataAs === 'form') {
							this.reqHeaders['content-type'] = 'application/x-www-form-urlencoded'
						}
					}

					if (!this.reqHeaders.hasOwnProperty('content-length')) {
						this.reqHeaders['content-length'] = Buffer.byteLength(this.data)
					}
				}
			}

			const options = Object.assign({
				'protocol': this.url.protocol,
				'host': this.url.hostname,
				'port': this.url.port,
				'path': this.url.pathname + (this.url.search === null ? '' : this.url.search),
				'method': this.method,
				'headers': this.reqHeaders
			}, this.coreOptions)
			//console.log("HTTP options:", JSON.stringify(options))

			let req

			const resHandler = (res) => {
				let stream = res

				if (this.compressionEnabled) {
					if (res.headers['content-encoding'] === 'gzip') {
						stream = res.pipe(zlib.createGunzip())
					}
					else if (res.headers['content-encoding'] === 'deflate') {
						stream = res.pipe(zlib.createInflate())
					}
				}

				let centraRes

				if (this.streamEnabled) {
					resolve(stream)
				}
				else {
					centraRes = new CentraResponse(res, this.resOptions)

					stream.on('error', (err) => {
						reject(err)
					})

					stream.on('aborted', () => {
						reject(new Error('Server aborted request'))
					})

					stream.on('data', (chunk) => {
						centraRes._addChunk(chunk)

						if (this.resOptions.maxBuffer !== null && centraRes.body.length > this.resOptions.maxBuffer) {
							stream.destroy()

							reject('Received a response which was longer than acceptable when buffering. (' + this.body.length + ' bytes)')
						}
					})

					stream.on('end', () => {
						resolve(centraRes)
					})
				}
			}

			if (this.url.protocol === 'http:') {
				req = http.request(options, resHandler)
			}
			else if (this.url.protocol === 'https:') {
				req = https.request(options, resHandler)
			}
			else throw new Error('Bad URL protocol: ' + this.url.protocol)

			if (this.timeoutTime) {
				req.setTimeout(this.timeoutTime, () => {
					req.abort()

					if (!this.streamEnabled) {
						reject(new Error('Timeout reached'))
					}
				})
			}

			req.on('error', (err) => {
				reject(err)
			})

			if (this.data) {
				if (this.sendDataAs === 'stream') {
					//console.log("HTTP body stream pipeline")
					pipeline(this.data,
						async function* (source) {
							let sz = 0
							let sha1 = crypto.createHash('sha1')
							for await (const chunk of source) {
								sz += chunk.length
								sha1.update(chunk)
							    yield chunk
							}
							console.log(`HTTP stream body: ${sz} bytes, sha1: ${sha1.digest('hex')}`)
						},
						req)
						.then(() => { req.end(); console.log("request ended") })
						.catch((e) => {throw new Error("Error sending request body: " + e)})
					return
				} else {
					//console.log("HTTP body is", Buffer.isBuffer(this.data) ? "buffer" : typeof this.data)
					req.write(this.data)
				}
			}
				
			req.end()
		})
	}
}

module.exports = (url, method) => { return new CentraRequest(url, method) }

// MIT License
//
// Copyright (c) 2018 Ethan Davis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
