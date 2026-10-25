import { generateKeyPair } from '@dsh-remote/crypto'
import { describe, expect, it } from 'vitest'
import {
  PairingError,
  PairingNonceRegistry,
  SAS_BITS,
  SAS_CHARS,
  createPairingOffer,
  deriveSas,
  normalizeSasInput,
  parsePairingOffer,
  sasMatches,
} from '../src/pairing.js'

const hostKeys = generateKeyPair()
const clientKeys = generateKeyPair()

describe('pairing offer', () => {
  it('round-trips a locally generated offer', () => {
    const { offer, uri } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey })
    expect(parsePairingOffer(uri)).toEqual(offer)
    expect(uri.startsWith('dshpair://v1?')).toBe(true)
  })

  it('rejects an expired code', () => {
    const { uri } = createPairingOffer({
      hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey, now: 1_000, ttlMs: 1_000,
    })
    expect(() => parsePairingOffer(uri, 2_001)).toThrow(PairingError)
  })

  it('rejects unknown, duplicated and version-mismatched payloads', () => {
    const { uri } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey })
    // The QR payload is authoritative: editing the device id just yields a
    // different offer, and a wrong key fails the Noise pin later, not here.
    expect(() => parsePairingOffer(uri.replace('host-1', 'host-2'))).not.toThrow()
    expect(() => parsePairingOffer(uri + '&x=1')).toThrow(PairingError)
    expect(() => parsePairingOffer(uri.replace('?h=', '?h=&h='))).toThrow(PairingError)
    expect(() => parsePairingOffer('dshpair://v2?h=host-1')).toThrow(PairingError)
  })

  it('refuses a non-base64url key', () => {
    expect(() => createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: 'not-a-key' })).toThrow(PairingError)
  })
})

describe('SAS', () => {
  const { offer } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey })

  it('is 60 bit and formatted for humans', () => {
    const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: clientKeys.publicKey, nonce: offer.nonce })
    expect(SAS_BITS).toBeGreaterThanOrEqual(40)
    expect(sas.replace(/-/gu, '')).toHaveLength(SAS_CHARS)
    expect(sas).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u)
  })

  it('agrees on both ends and changes with every input', () => {
    const base = { hostPublicKey: hostKeys.publicKey, clientPublicKey: clientKeys.publicKey, nonce: offer.nonce }
    expect(deriveSas(base)).toBe(deriveSas(base))
    expect(deriveSas({ ...base, nonce: createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey }).offer.nonce }))
      .not.toBe(deriveSas(base))
    expect(deriveSas({ ...base, clientPublicKey: generateKeyPair().publicKey })).not.toBe(deriveSas(base))
  })

  it('accepts lenient typing but not a different code', () => {
    const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: clientKeys.publicKey, nonce: offer.nonce })
    expect(normalizeSasInput(sas.toLowerCase())).toBe(sas)
    expect(normalizeSasInput(` ${sas.replace(/-/gu, ' ')} `)).toBe(sas)
    expect(sasMatches(sas, sas.toLowerCase())).toBe(true)
    expect(sasMatches(sas, sas.replace(/.$/, char => (char === 'A' ? 'B' : 'A')))).toBe(false)
    expect(() => normalizeSasInput('ABC')).toThrow(PairingError)
  })
})

describe('pairing nonce', () => {
  it('accepts one live offer, then refuses reuse after consumption', () => {
    const registry = new PairingNonceRegistry()
    const { offer } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey })
    registry.register(offer)
    expect(registry.accepts('host-1', offer.nonce)).toBe(true)
    registry.consume('host-1')
    expect(registry.accepts('host-1', offer.nonce)).toBe(false)
  })

  it('refuses an expired nonce and a replay of an older offer', () => {
    const registry = new PairingNonceRegistry()
    const first = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey, now: 1_000, ttlMs: 1_000 }).offer
    const second = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: hostKeys.publicKey, now: 1_500, ttlMs: 1_000 }).offer
    registry.register(first)
    registry.register(second)
    // Only the most recent offer stays live for a Host.
    expect(registry.accepts('host-1', first.nonce)).toBe(false)
    expect(registry.accepts('host-1', second.nonce, 2_600)).toBe(false)
  })
})
