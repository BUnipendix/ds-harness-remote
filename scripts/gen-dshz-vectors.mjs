// Generates DSHZ compression golden vectors with node:zlib so other
// implementations (dsh-go's Dart client) can prove decode compatibility.
//
//   node scripts/gen-dshz-vectors.mjs <output.json>
//
// Vectors pin the scheme negotiated as `harness.remote.compress.v1`:
// zlib-format deflate, a preset dictionary (the rolling last-32 KiB plaintext
// window the codec passes per message), level 6 for reproducibility. The dictionary here
// is synthetic filler — vectors never embed real communication.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (out === undefined) {
  console.error('usage: node scripts/gen-dshz-vectors.mjs <output.json>')
  process.exit(2)
}

/** Deterministic xorshift bytes deflate cannot shrink. */
function incompressible(bytes) {
  const data = new Uint8Array(bytes)
  let state = 0x2545f491
  for (let index = 0; index < bytes; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    data[index] = state & 0xff
  }
  return data
}

/** JSON-ish repetitive text sharing vocabulary across messages. */
function jsonish(bytes, seed) {
  const parts = ['{"sessionId":"s-', '1234","records":[{"seq":',
    ',"event":{"type":"tool.output","text":"literally the same tool output body"',
    '}}],"hasMore":']
  let out = ''
  let length = 0
  let index = 0
  while (length < bytes) {
    const part = parts[index % parts.length] + String(seed + index)
    out += part
    length += part.length
    index += 1
  }
  return new TextEncoder().encode(out.slice(0, bytes))
}

const pack = (data, dictionary) => deflateSync(Buffer.from(data), {
  level: 6,
  ...(dictionary.byteLength > 0 ? { dictionary: Buffer.from(dictionary) } : {}),
})

const empty = new Uint8Array(0)
const filler = jsonish(32 * 1024, 7) // a full 32 KiB rolling window of context
const cases = [
  { name: 'small verbatim under threshold', plain: jsonish(511, 1), dictionary: empty },
  { name: 'jsonish no dictionary', plain: jsonish(64 * 1024, 2), dictionary: empty },
  { name: 'jsonish with full 32 KiB dictionary', plain: jsonish(64 * 1024, 3), dictionary: filler },
  { name: 'incompressible with dictionary', plain: incompressible(48 * 1024 + 7), dictionary: filler },
  { name: 'empty dictionary bytes only', plain: new Uint8Array(0), dictionary: empty },
]

const vectors = cases.map(testCase => ({
  name: testCase.name,
  plainB64: Buffer.from(testCase.plain).toString('base64'),
  dictionaryB64: Buffer.from(testCase.dictionary).toString('base64'),
  packedB64: pack(testCase.plain, testCase.dictionary).toString('base64'),
}))

// Self-check: what node produced, node can decode.
for (const vector of vectors) {
  const { inflateSync } = await import('node:zlib')
  const restored = inflateSync(Buffer.from(vector.packedB64, 'base64'),
    vector.dictionaryB64.length > 0 ? { dictionary: Buffer.from(vector.dictionaryB64, 'base64') } : {})
  if (Buffer.compare(restored, Buffer.from(vector.plainB64, 'base64')) !== 0) {
    throw new Error(`self-check failed for "${vector.name}"`)
  }
}

writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`)
console.log(`wrote ${vectors.length} vectors to ${out}`)
