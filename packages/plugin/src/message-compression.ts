import { deflateSync, inflateSync } from 'node:zlib'
import type { MessageCompressor } from '@dsh-remote/protocol'

/**
 * node:zlib deflate implementation of the protocol's compression primitives,
 * zlib framing (2-byte header + adler32) because the preset dictionary is
 * only honored there on every runtime this must interoperate with
 * (dart:io's raw-mode dictionary is silently ignored). Level 9 by default:
 * the Host side compresses the multi-MiB snapshots where the ratio matters,
 * and it runs on desktop hardware. The preset dictionary is the rolling
 * plaintext window supplied per message by the codec — it never leaves the
 * endpoints.
 */
export function nodeMessageCompressor(level = 9): MessageCompressor {
  const asBuffer = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return {
    deflate(data, dictionary) {
      return new Uint8Array(deflateSync(asBuffer(data), {
        level,
        ...(dictionary.byteLength > 0 ? { dictionary: asBuffer(dictionary) } : {}),
      }))
    },
    inflate(data, dictionary) {
      return new Uint8Array(inflateSync(asBuffer(data), {
        ...(dictionary.byteLength > 0 ? { dictionary: asBuffer(dictionary) } : {}),
      }))
    },
  }
}
