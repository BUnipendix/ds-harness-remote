import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  SECURE_COMPRESSION_DICTIONARY_BYTES,
  SECURE_COMPRESSION_MIN_MESSAGE_BYTES,
  SecureMessageCodec,
  RollingPlaintextWindow,
  type MessageCompressor,
} from '../src/index.js'

/** Deterministic node:zlib compressor mirroring the plugin's factory (level 6 for speed). */
const compressor: MessageCompressor = {
  deflate: (data, dictionary) => new Uint8Array(deflateSync(Buffer.from(data), {
    level: 6,
    ...(dictionary.byteLength > 0 ? { dictionary: Buffer.from(dictionary) } : {}),
  })),
  inflate: (data, dictionary) => new Uint8Array(inflateSync(Buffer.from(data), {
    ...(dictionary.byteLength > 0 ? { dictionary: Buffer.from(dictionary) } : {}),
  })),
}

/** A payload deflate cannot shrink: high-entropy bytes. */
function incompressible(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes)
  let state = 0x2545f491
  for (let index = 0; index < bytes; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    data[index] = state & 0xff
  }
  return data
}

/** JSON-ish repetitive text: compresses well, shares vocabulary across messages. */
function jsonish(bytes: number, seed: number): Uint8Array {
  const parts = ['{"sessionId":"s-','1234","records":[{"seq":',',"event":{"type":"tool.output","text":"literally the same tool output body"','}}],"hasMore":']
  let out = ''
  let length = 0
  let index = 0
  while (length < bytes) {
    const part = parts[index % parts.length] + (seed + index)
    out += part
    length += part.length
    index += 1
  }
  return new TextEncoder().encode(out.slice(0, bytes))
}

/** Drives one direction: encode on `sender`, decode on `receiver`. */
function transfer(sender: SecureMessageCodec, receiver: SecureMessageCodec, message: Uint8Array): Uint8Array {
  let decoded: Uint8Array | undefined
  for (const frame of sender.encode(message)) {
    const next = receiver.decode(frame)
    if (next !== undefined) decoded = next
  }
  expect(decoded).toBeDefined()
  return decoded!
}

describe('secure-message compression (DSHZ)', () => {
  it('roundtrips a large message across DSHZ fragments', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()

    // Incompressible on purpose: it must stay above one fragment even after
    // the verbatim fallback, so the fragmented path is exercised.
    const message = incompressible(200_000)
    const frames = sender.encode(message)
    expect(frames.length).toBeGreaterThan(1)
    let decoded: Uint8Array | undefined
    for (const frame of frames) {
      const next = receiver.decode(frame)
      if (next !== undefined) decoded = next
    }
    expect(decoded).toEqual(message)
  })

  it('frames messages below the threshold without deflating them', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()

    const small = jsonish(SECURE_COMPRESSION_MIN_MESSAGE_BYTES - 1, 2)
    const frames = sender.encode(small)
    expect(frames.length).toBe(1)
    // 18-byte DSHZ header, flags byte clear: framed but verbatim.
    expect(frames[0].byteLength).toBe(18 + small.byteLength)
    expect(frames[0][17]).toBe(0)
    expect(receiver.decode(frames[0])).toEqual(small)
  })

  it('falls back to a verbatim DSHZ frame when deflate does not shrink', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()

    const message = incompressible(10_000)
    const frames = sender.encode(message)
    expect(frames[0][17]).toBe(0)
    let decoded: Uint8Array | undefined
    for (const frame of frames) {
      const next = receiver.decode(frame)
      if (next !== undefined) decoded = next
    }
    expect(decoded).toEqual(message)
  })

  it('uses the previous plaintext as the dictionary for the next message', () => {
    const first = jsonish(4_000, 1)

    // Baseline sender with the same window state (first already flowed), but
    // compressing `second` for the first time without a dictionary benefit.
    const plainSender = new SecureMessageCodec(compressor)
    const plainReceiver = new SecureMessageCodec(compressor)
    plainSender.enableCompression()
    plainReceiver.enableCompression()
    transfer(plainSender, plainReceiver, first)

    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()
    transfer(sender, receiver, first)

    const second = jsonish(4_000, 2) // largely shares vocabulary with the first
    const withDictionary = sender.encode(second)
    // True baseline: the same message from a codec whose window is empty.
    const bareSender = new SecureMessageCodec(compressor)
    bareSender.enableCompression()
    const bare = bareSender.encode(second)[0]
    // The rolling dictionary must actually buy something on shared text.
    expect(withDictionary[0].byteLength).toBeLessThan(bare.byteLength)
    let decoded: Uint8Array | undefined
    for (const frame of withDictionary) {
      const next = receiver.decode(frame)
      if (next !== undefined) decoded = next
    }
    expect(decoded).toEqual(second)
  })

  it('decodes legacy DSHF and raw frames interleaved with DSHZ', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    receiver.enableCompression()

    const legacySmall = jsonish(300, 3)
    expect(receiver.decode(sender.encode(legacySmall)[0])).toEqual(legacySmall)

    const legacyLarge = jsonish(120_000, 4)
    let decoded: Uint8Array | undefined
    for (const frame of sender.encode(legacyLarge)) {
      const next = receiver.decode(frame)
      if (next !== undefined) decoded = next
    }
    expect(decoded).toEqual(legacyLarge)

    sender.enableCompression()
    const compressed = jsonish(20_000, 5)
    expect(transfer(sender, receiver, compressed)).toEqual(compressed)
  })

  it('refuses DSHZ frames on a codec without a compressor', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec()
    sender.enableCompression()
    const frames = sender.encode(jsonish(10_000, 6))
    expect(() => receiver.decode(frames[0])).toThrow()
  })

  it('rejects unknown DSHZ flag bits', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()
    const frames = sender.encode(jsonish(10_000, 7))
    frames[0][17] = 0xfe
    expect(() => receiver.decode(frames[0])).toThrow()
  })

  it('reset clears the rolling window so a new connection starts clean', () => {
    const window = new RollingPlaintextWindow()
    window.append(jsonish(SECURE_COMPRESSION_DICTIONARY_BYTES + 100, 8))
    expect(window.snapshot().byteLength).toBe(SECURE_COMPRESSION_DICTIONARY_BYTES)
    window.reset()
    expect(window.snapshot().byteLength).toBe(0)
  })

  it('keeps the window at the dictionary ceiling', () => {
    const window = new RollingPlaintextWindow()
    window.append(new Uint8Array(10).fill(1))
    window.append(jsonish(SECURE_COMPRESSION_DICTIONARY_BYTES, 9))
    expect(window.snapshot().byteLength).toBe(SECURE_COMPRESSION_DICTIONARY_BYTES)
    // The short early append must have been rotated out.
    expect(Array.from(window.snapshot().slice(0, 10))).not.toEqual(Array(10).fill(1))
  })

  it('decompression failure surfaces as a channel-fatal error', () => {
    const sender = new SecureMessageCodec(compressor)
    const receiver = new SecureMessageCodec(compressor)
    sender.enableCompression()
    receiver.enableCompression()
    const frames = sender.encode(jsonish(10_000, 10))
    // Corrupt the deflated payload: the mirror is broken either way.
    frames[0][30] ^= 0xff
    expect(() => {
      for (const frame of frames) receiver.decode(frame)
    }).toThrow(/decompression failed/)
  })
})
