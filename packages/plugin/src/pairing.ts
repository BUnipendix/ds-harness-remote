import {
  DEFAULT_PAIRING_TTL_MS,
  PAIRING_SAS_CHARS,
  PAIRING_SCHEME,
  PairingCodeError,
  PairingCodeError as PairingError,
  createPairingNonce,
  createPairingOffer,
  derivePairingSas,
  normalizePairingCode,
  pairingSasMatches,
  parsePairingOffer,
  type PairingOffer,
  type PairingOfferInput,
} from '@dsh-remote/crypto'

/**
 * Out-of-band device pairing (L2 identity in `docs/design/minimal-secure-channel.md`).
 *
 * The cryptographic and payload primitives live in `@dsh-remote/crypto` so the
 * Host, Desktop, Android and the browser derive identical codes. This module
 * keeps only the Host-side pieces: the error type and the single-use nonce
 * bookkeeping.
 *
 * Nothing here may consume Server input. There are exactly two out-of-band
 * channels and they are the only trust inputs:
 *
 *   1. the QR payload the Host renders locally and the Controller scans;
 *   2. the short code a human reads on one screen and types on the other.
 *
 * Every value that decides "who is the peer" comes from one of those two, or
 * from the already authenticated Noise channel. Never from a descriptor,
 * `hello.ack` capability, or any other pre-encryption Server field.
 */

export { DEFAULT_PAIRING_TTL_MS, PAIRING_SCHEME, createPairingOffer, parsePairingOffer }
export type { PairingOffer, PairingOfferInput }

/** 12 base32 characters = 60 bit. Below ~40 bit an offline key search wins. */
export const SAS_BITS = 60
export const SAS_CHARS = PAIRING_SAS_CHARS

/**
 * One error type for every pairing failure. It is the shared class itself, so
 * `instanceof` works across the Host, Android and the browser.
 */
export { PairingError }

export interface SasInput {
  hostPublicKey: string
  clientPublicKey: string
  nonce: string
}

/**
 * The Host-side view of the shared SAS derivation. Android, the browser and the
 * Desktop all call the same `@dsh-remote/crypto` implementation, so the codes
 * cannot drift between platforms.
 */
export function deriveSas(input: SasInput): string {
  try {
    return derivePairingSas(input)
  } catch (error) {
    throw error instanceof PairingCodeError
      ? new PairingError(error.code, error.message)
      : error
  }
}

export function normalizeSasInput(input: string): string {
  try {
    return normalizePairingCode(input)
  } catch (error) {
    throw error instanceof PairingCodeError
      ? new PairingError(error.code, error.message)
      : error
  }
}

export function sasMatches(expected: string, typed: string): boolean {
  try {
    return pairingSasMatches(expected, typed)
  } catch (error) {
    throw error instanceof PairingCodeError
      ? new PairingError(error.code, error.message)
      : error
  }
}

/**
 * Single-use pairing nonce bookkeeping: one open offer per Host, consumed on
 * success, and refused after its expiry so a recorded SAS relation cannot be
 * replayed into a later pairing.
 */
export class PairingNonceRegistry {
  private readonly open = new Map<string, { nonce: string; expiresAt: number }>()

  register(offer: PairingOffer): void {
    for (const [deviceId, entry] of this.open) if (entry.expiresAt <= Date.now()) this.open.delete(deviceId)
    this.open.set(offer.hostDeviceId, { nonce: offer.nonce, expiresAt: offer.expiresAt })
  }

  /** The live nonce for a Host, if an unexpired offer is open. */
  active(hostDeviceId: string, now = Date.now()): string | undefined {
    const entry = this.open.get(hostDeviceId)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) { this.open.delete(hostDeviceId); return undefined }
    return entry.nonce
  }

  /** Expiry of the live offer, used to bound a waiting pairing tunnel. */
  expiryOf(hostDeviceId: string, now = Date.now()): number | undefined {
    const entry = this.open.get(hostDeviceId)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) { this.open.delete(hostDeviceId); return undefined }
    return entry.expiresAt
  }

  /** True when this nonce is the single live offer for the Host. */
  accepts(hostDeviceId: string, nonce: string, now = Date.now()): boolean {
    const entry = this.open.get(hostDeviceId)
    if (entry === undefined) return false
    if (entry.expiresAt <= now) { this.open.delete(hostDeviceId); return false }
    return entry.nonce === nonce
  }

  /** Drop the offer after a successful pairing; a nonce never works twice. */
  consume(hostDeviceId: string): void {
    this.open.delete(hostDeviceId)
  }

  clear(): void { this.open.clear() }
}

export { createPairingNonce }
