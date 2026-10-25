import { randomBytes } from '@noble/ciphers/webcrypto'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { fromBase64Url, toBase64Url } from './index.js'

/**
 * Platform-neutral pairing primitives, shared by every Remote peer.
 *
 * The Host, the Desktop/Android/VS Code Controller and the browser all derive
 * the same confirmation code from the same three inputs. Nothing here touches
 * Node built-ins, so React Native and browsers run the identical code.
 *
 * Both values below must stay in sync with `docs/design/minimal-secure-channel.md`:
 * a shorter code can be searched offline, and a different KDF breaks pairing.
 */

/** 60 bit: below ~40 bit an attacker can enumerate keys that collide. */
export const PAIRING_SAS_BITS = 60
export const PAIRING_SAS_CHARS = PAIRING_SAS_BITS / 5
export const PAIRING_SAS_INFO = 'dsh-sas-v1'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export class PairingCodeError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export interface PairingSasInput {
  /** The device that rendered the QR code (the DSH / Harness side). */
  hostPublicKey: string
  /** The device that scanned it (the Controller). */
  clientPublicKey: string
  /** Single-use value from the QR payload; never sent over the network. */
  nonce: string
}

/**
 * Short Authentication String derived from both static keys and the pairing
 * nonce, formatted for a human comparison as `XXXX-XXXX-XXXX`.
 */
export function derivePairingSas(input: PairingSasInput): string {
  const host = requireKey(input.hostPublicKey, 'host public key')
  const client = requireKey(input.clientPublicKey, 'client public key')
  const nonce = requireKey(input.nonce, 'pairing nonce')
  const ikm = new Uint8Array(host.byteLength + client.byteLength)
  ikm.set(host, 0)
  ikm.set(client, host.byteLength)
  const derived = hkdf(
    sha256,
    ikm,
    nonce,
    new TextEncoder().encode(PAIRING_SAS_INFO),
    Math.ceil((PAIRING_SAS_CHARS * 5) / 8),
  )
  return toBase32(derived).slice(0, PAIRING_SAS_CHARS).match(/.{1,4}/gu)!.join('-')
}

/**
 * Normalize what a human typed: case-insensitive, separators ignored, base32
 * alphabet only. Returns the canonical grouped form used by
 * {@link pairingSasMatches}.
 */
export function normalizePairingCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z2-7]/gu, '')
  if (compact.length !== PAIRING_SAS_CHARS) {
    throw new PairingCodeError('SAS_INVALID', `Enter all ${PAIRING_SAS_CHARS} characters of the code shown on the other device.`)
  }
  return compact.match(/.{1,4}/gu)!.join('-')
}

/** Constant-time comparison of a normalized code against the derived value. */
export function pairingSasMatches(expected: string, typed: string): boolean {
  const left = new TextEncoder().encode(normalizePairingCode(expected))
  const right = new TextEncoder().encode(normalizePairingCode(typed))
  if (left.byteLength !== right.byteLength) return false
  let different = 0
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!
  return different === 0
}

/** Fresh single-use pairing nonce, as base64url. */
export function createPairingNonce(random: (length: number) => Uint8Array = length => new Uint8Array(randomBytes(length))): string {
  const bytes = random(32)
  if (bytes.byteLength !== 32) throw new PairingCodeError('PAIRING_INVALID_NONCE', 'Pairing nonce must be 32 bytes.')
  return toBase64Url(bytes)
}

function requireKey(value: string, label: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(value)
  } catch {
    throw new PairingCodeError('PAIRING_INVALID_KEY', `${label} is not base64url.`)
  }
  if (bytes.byteLength !== 32) throw new PairingCodeError('PAIRING_INVALID_KEY', `${label} must be 32 bytes.`)
  return bytes
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Pairing offer codec
//
// Deliberately hand-rolled: Android and the VS Code extension do not depend on
// zod, and this payload is a local UI contract rather than a wire frame.
// ────────────────────────────────────────────────────────────────────────────

export const PAIRING_SCHEME = 'dshpair://v1'
export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000
const MAX_DEVICE_ID_LENGTH = 64
const MAX_DEVICE_NAME_LENGTH = 80
const BASE64URL_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u
const KNOWN_KEYS = new Set(['h', 'k', 'n', 'e', 'd'])

export interface PairingOffer {
  /** The device that shows the QR code. */
  hostDeviceId: string
  /** Its X25519 identity key, base64url. */
  hostPublicKey: string
  /** Single-use value; the code is derived from it and never transmitted. */
  nonce: string
  expiresAt: number
  hostDeviceName?: string
}

export interface PairingOfferInput {
  hostDeviceId: string
  hostPublicKey: string
  hostDeviceName?: string
  now?: number
  ttlMs?: number
  random?: (length: number) => Uint8Array
}

/** Build the offer and the URI rendered on the Host screen. */
export function createPairingOffer(input: PairingOfferInput): { offer: PairingOffer; uri: string } {
  if (input.hostDeviceId.length === 0 || input.hostDeviceId.length > MAX_DEVICE_ID_LENGTH) {
    throw new PairingCodeError('PAIRING_INVALID_DEVICE_ID', 'Host device id is not usable in a pairing offer.')
  }
  if (!BASE64URL_KEY.test(input.hostPublicKey)) {
    throw new PairingCodeError('PAIRING_INVALID_KEY', 'Host public key must be a 32-byte base64url X25519 key.')
  }
  const name = input.hostDeviceName?.trim()
  if (name !== undefined && (name.length === 0 || name.length > MAX_DEVICE_NAME_LENGTH)) {
    throw new PairingCodeError('PAIRING_INVALID_NAME', 'Host device name must be 1-80 characters.')
  }
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_PAIRING_TTL_MS) {
    throw new PairingCodeError('PAIRING_INVALID_TTL', 'Pairing offer lifetime must be positive and at most five minutes.')
  }
  const nonce = createPairingNonce(input.random)
  const expiresAt = now + ttlMs
  const offer: PairingOffer = {
    hostDeviceId: input.hostDeviceId,
    hostPublicKey: input.hostPublicKey,
    nonce,
    expiresAt,
    ...(name === undefined ? {} : { hostDeviceName: name }),
  }
  const uri = `${PAIRING_SCHEME}?h=${encodeURIComponent(offer.hostDeviceId)}&k=${offer.hostPublicKey}`
    + `&n=${nonce}&e=${expiresAt}`
    + (name === undefined ? '' : `&d=${encodeURIComponent(name)}`)
  return { offer, uri }
}

/** Parse a scanned pairing URI. Rejects expired, malformed and extended payloads. */
export function parsePairingOffer(uri: string, now = Date.now()): PairingOffer {
  const trimmed = uri.trim()
  const prefix = `${PAIRING_SCHEME}?`
  if (!trimmed.startsWith(prefix)) throw new PairingCodeError('PAIRING_INVALID_URI', 'Not a DSH Remote pairing code.')
  const params: Record<string, string> = {}
  for (const part of trimmed.slice(prefix.length).split('&')) {
    if (part === '') continue
    const separator = part.indexOf('=')
    if (separator <= 0) throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code has a malformed parameter.')
    const key = part.slice(0, separator)
    if (!KNOWN_KEYS.has(key)) throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code has an unknown parameter.')
    if (Object.hasOwn(params, key)) throw new PairingCodeError('PAIRING_INVALID_URI', 'Duplicate pairing parameter.')
    try {
      params[key] = decodeURIComponent(part.slice(separator + 1))
    } catch {
      throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code has an invalid escape sequence.')
    }
  }
  const { h, k, n, e, d } = params
  if (h === undefined || h.length === 0 || h.length > MAX_DEVICE_ID_LENGTH) {
    throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code is missing the Host device id.')
  }
  if (k === undefined || !BASE64URL_KEY.test(k)) {
    throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code is missing a valid Host public key.')
  }
  if (n === undefined || !BASE64URL_KEY.test(n)) {
    throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code is missing a valid nonce.')
  }
  if (e === undefined || !/^\d{1,16}$/u.test(e)) {
    throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code is missing an expiry.')
  }
  const expiresAt = Number(e)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new PairingCodeError('PAIRING_EXPIRED', 'Pairing code has expired; generate a new one on the Host.')
  }
  if (d !== undefined && (d.length === 0 || d.length > MAX_DEVICE_NAME_LENGTH)) {
    throw new PairingCodeError('PAIRING_INVALID_URI', 'Pairing code has an invalid device name.')
  }
  return {
    hostDeviceId: h,
    hostPublicKey: k,
    nonce: n,
    expiresAt,
    ...(d === undefined ? {} : { hostDeviceName: d }),
  }
}
