// Frame codecs for the Amazon Quick chat WebSocket, ported from
// aws-quickwork-2api's internal/proxy/wire.go.
//
// AWS event-stream framing:
// [total_len:4][headers_len:4][prelude_crc:4][headers][payload][message_crc:4]

const HV_BOOL_TRUE = 0
const HV_BOOL_FALSE = 1
const HV_BYTE = 2
const HV_SHORT = 3
const HV_INT = 4
const HV_LONG = 5
const HV_BYTES = 6
const HV_STRING = 7
const HV_TIMESTAMP = 8
const HV_UUID = 9

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === "string") return encoder.encode(data)
  throw new TypeError("expected bytes")
}

export function eventStreamEncode(headers, payload) {
  const parts = []
  let headersLen = 0
  for (const [name, value] of Object.entries(headers)) {
    const nb = encoder.encode(name)
    const vb = encoder.encode(value)
    const part = new Uint8Array(1 + nb.length + 3 + vb.length)
    part[0] = nb.length
    part.set(nb, 1)
    part[1 + nb.length] = HV_STRING
    part[2 + nb.length] = vb.length >> 8
    part[3 + nb.length] = vb.length & 0xff
    part.set(vb, 4 + nb.length)
    parts.push(part)
    headersLen += part.length
  }
  const body = toBytes(payload)
  const total = 12 + headersLen + body.length + 4
  const msg = new Uint8Array(total)
  const view = new DataView(msg.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headersLen)
  view.setUint32(8, crc32(msg.subarray(0, 8)))
  let pos = 12
  for (const part of parts) {
    msg.set(part, pos)
    pos += part.length
  }
  msg.set(body, pos)
  view.setUint32(total - 4, crc32(msg.subarray(0, total - 4)))
  return msg
}

function decodeEventHeaders(b) {
  const out = {}
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let i = 0
  const need = (n, what) => {
    if (i + n > b.length) throw new Error(`truncated ${what}`)
  }
  while (i < b.length) {
    const nameLen = b[i++]
    need(nameLen, "event header name")
    const name = decoder.decode(b.subarray(i, i + nameLen))
    i += nameLen
    need(1, "event header type")
    const type = b[i++]
    switch (type) {
      case HV_BOOL_TRUE:
        out[name] = true
        break
      case HV_BOOL_FALSE:
        out[name] = false
        break
      case HV_BYTE:
        need(1, "byte header")
        out[name] = b[i++]
        break
      case HV_SHORT:
        need(2, "short header")
        out[name] = view.getUint16(i)
        i += 2
        break
      case HV_INT:
        need(4, "int header")
        out[name] = view.getUint32(i)
        i += 4
        break
      case HV_LONG:
      case HV_TIMESTAMP:
        need(8, "long header")
        out[name] = Number(view.getBigUint64(i))
        i += 8
        break
      case HV_BYTES:
      case HV_STRING: {
        need(2, "header length")
        const n = view.getUint16(i)
        i += 2
        need(n, "header value")
        const value = b.slice(i, i + n)
        out[name] = type === HV_STRING ? decoder.decode(value) : value
        i += n
        break
      }
      case HV_UUID:
        need(16, "uuid header")
        out[name] = b.slice(i, i + 16)
        i += 16
        break
      default:
        throw new Error(`unsupported event header type ${type}`)
    }
  }
  return out
}

// Decodes every complete message in buf.
export function eventStreamDecodeAll(data) {
  const buf = toBytes(data)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const messages = []
  let pos = 0
  while (pos + 16 <= buf.length) {
    const total = view.getUint32(pos)
    if (total < 16 || total > 16 * 1024 * 1024) throw new Error(`invalid event-stream frame length ${total}`)
    if (pos + total > buf.length) break
    const headersLen = view.getUint32(pos + 4)
    const hstart = pos + 12
    const hend = hstart + headersLen
    if (hend > pos + total - 4) throw new Error(`invalid event-stream header length ${headersLen}`)
    messages.push({
      headers: decodeEventHeaders(buf.subarray(hstart, hend)),
      payload: buf.slice(hend, pos + total - 4),
    })
    pos += total
  }
  return { messages, consumed: pos }
}

function headerString(headers, key) {
  const v = headers[key]
  if (typeof v === "string") return v
  if (v instanceof Uint8Array) return decoder.decode(v)
  return ""
}

// Minimal CBOR (RPC v2), covering the shapes of the Gateway bidi protocol.

function cborHead(major, n, out) {
  const m = major << 5
  if (n < 24) out.push(m | n)
  else if (n <= 0xff) out.push(m | 24, n)
  else if (n <= 0xffff) out.push(m | 25, n >> 8, n & 0xff)
  else if (n <= 0xffffffff) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  else {
    const big = BigInt(n)
    out.push(m | 27)
    for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 0xffn))
  }
}

function cborEncodeInto(v, out) {
  if (v === null || v === undefined) out.push(0xf6)
  else if (v === true) out.push(0xf5)
  else if (v === false) out.push(0xf4)
  else if (typeof v === "number" && Number.isInteger(v)) {
    if (v >= 0) cborHead(0, v, out)
    else cborHead(1, -1 - v, out)
  } else if (typeof v === "string") {
    const b = encoder.encode(v)
    cborHead(3, b.length, out)
    for (const x of b) out.push(x)
  } else if (v instanceof Uint8Array) {
    cborHead(2, v.length, out)
    for (const x of v) out.push(x)
  } else if (Array.isArray(v)) {
    cborHead(4, v.length, out)
    for (const item of v) cborEncodeInto(item, out)
  } else if (typeof v === "object") {
    const entries = Object.entries(v)
    cborHead(5, entries.length, out)
    for (const [k, val] of entries) {
      cborEncodeInto(k, out)
      cborEncodeInto(val, out)
    }
  } else throw new Error(`cannot CBOR-encode ${typeof v}`)
}

export function cborEncode(v) {
  const out = []
  cborEncodeInto(v, out)
  return Uint8Array.from(out)
}

function halfToFloat(h) {
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  const sign = h & 0x8000 ? -1 : 1
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
  if (exp === 31) return frac ? NaN : sign * Infinity
  return sign * 2 ** (exp - 15) * (1 + frac / 1024)
}

function cborDecodeAt(data, view, start) {
  let i = start
  if (i >= data.length) throw new Error("truncated CBOR")
  const initial = data[i++]
  const major = initial >> 5
  const info = initial & 0x1f
  const need = (n) => {
    if (i + n > data.length) throw new Error("truncated CBOR")
  }
  let n = info
  let at = i
  if (info === 24) {
    need(1)
    n = data[i]
    i += 1
  } else if (info === 25) {
    need(2)
    n = view.getUint16(i)
    i += 2
  } else if (info === 26) {
    need(4)
    n = view.getUint32(i)
    i += 4
  } else if (info === 27) {
    need(8)
    n = Number(view.getBigUint64(i))
    i += 8
  } else if (info >= 28) throw new Error(`unsupported CBOR additional info ${info}`)

  switch (major) {
    case 0:
      return [n, i]
    case 1:
      return [-1 - n, i]
    case 2:
      need(n)
      return [data.slice(i, i + n), i + n]
    case 3:
      need(n)
      return [decoder.decode(data.subarray(i, i + n)), i + n]
    case 4: {
      const arr = []
      for (let k = 0; k < n; k++) {
        const [item, next] = cborDecodeAt(data, view, i)
        arr.push(item)
        i = next
      }
      return [arr, i]
    }
    case 5: {
      const map = {}
      for (let k = 0; k < n; k++) {
        const [key, afterKey] = cborDecodeAt(data, view, i)
        const [val, afterVal] = cborDecodeAt(data, view, afterKey)
        map[key instanceof Uint8Array ? decoder.decode(key) : String(key)] = val
        i = afterVal
      }
      return [map, i]
    }
    case 6:
      // Tag: decode the tagged value and ignore the tag itself.
      return cborDecodeAt(data, view, i)
    default:
      switch (info) {
        case 20:
          return [false, i]
        case 21:
          return [true, i]
        case 22:
        case 23:
          return [null, i]
        case 25:
          return [halfToFloat(view.getUint16(at)), i]
        case 26:
          return [view.getFloat32(at), i]
        case 27:
          return [view.getFloat64(at), i]
      }
      throw new Error(`unsupported CBOR simple value ${info}`)
  }
}

export function cborDecode(input) {
  const data = toBytes(input)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return cborDecodeAt(data, view, 0)[0]
}

function frameError(headers) {
  const type = headerString(headers, ":message-type")
  if (type !== "error" && type !== "exception") return null
  const code = headerString(headers, ":error-code") || headerString(headers, ":exception-type")
  return new Error(`upstream error [${code}] ${headerString(headers, ":error-message")}`)
}

// AIDP (enterprise/social) bidi codec.
// Outbound: UTF-8 JSON {"eventType":"rawInputEvent","payload":{"payload":b64}}
// Inbound:  AWS event-stream whose body is {"payload": b64(json)}

export function aidpEncode(json) {
  const b64 = Buffer.from(json, "utf8").toString("base64")
  return encoder.encode(JSON.stringify({ eventType: "rawInputEvent", payload: { payload: b64 } }))
}

// Returns the JSON string of every event in one WebSocket frame.
export function aidpDecode(data) {
  const bytes = toBytes(data)
  let messages = []
  let failure = null
  try {
    messages = eventStreamDecodeAll(bytes).messages
  } catch (e) {
    failure = e
  }
  if (!messages.length) {
    // Some servers may answer with a plain JSON frame.
    const text = decoder.decode(bytes)
    try {
      const probe = JSON.parse(text)
      if (probe && typeof probe === "object" && !Array.isArray(probe)) return [text]
    } catch {}
    throw new Error(`decode AIDP event-stream: ${failure?.message ?? "no complete frame"}`)
  }
  return messages.map((msg) => {
    const err = frameError(msg.headers)
    if (err) throw err
    let outer
    try {
      outer = JSON.parse(decoder.decode(msg.payload))
    } catch (e) {
      throw new Error(`decode AIDP body: ${e.message}`)
    }
    if (!outer || typeof outer.payload !== "string" || !outer.payload) throw new Error("AIDP body has no payload")
    return Buffer.from(outer.payload, "base64").toString("utf8")
  })
}

// Gateway (gateway/social_gateway) bidi codec: event-stream + CBOR
// {"payload": json_bytes} in both directions.

export function gatewayEncode(json) {
  return eventStreamEncode(
    { ":event-type": "rawInputEvent", ":content-type": "application/cbor", ":message-type": "event" },
    cborEncode({ payload: encoder.encode(json) }),
  )
}

export function gatewayDecode(data) {
  let messages
  try {
    messages = eventStreamDecodeAll(data).messages
  } catch (e) {
    throw new Error(`decode gateway event-stream: ${e.message}`)
  }
  if (!messages.length) throw new Error("decode gateway event-stream: no complete frame")
  return messages.map((msg) => {
    const err = frameError(msg.headers)
    if (err) throw err
    let value
    try {
      value = cborDecode(msg.payload)
    } catch (e) {
      throw new Error(`decode gateway CBOR: ${e.message}`)
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("gateway CBOR is not a map")
    if (value.payload instanceof Uint8Array) return decoder.decode(value.payload)
    if (typeof value.payload === "string") return value.payload
    throw new Error("gateway CBOR has no payload")
  })
}

export function isGatewayProvider(provider) {
  const p = String(provider ?? "").toLowerCase()
  return p === "gateway" || p === "social_gateway"
}
