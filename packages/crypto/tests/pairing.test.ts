import { describe, expect, it } from 'vitest'
import {
  PAIRING_SAS_BITS,
  PAIRING_SAS_CHARS,
  PairingCodeError,
  createPairingNonce,
  derivePairingSas,
  generateKeyPair,
  normalizePairingCode,
  pairingSasMatches,
  toBase64Url,
} from '../src/index.js'

/**
 * These primitives are shared by the Host, Desktop, Android and the browser, so
 * the assertions here define the contract every platform must match. Changing
 * the KDF, the alphabet or the length breaks pairing on the other devices.
 */

const host = generateKeyPair()
const controller = generateKeyPair()
const nonce = createPairingNonce()

describe('shared pairing primitives', () => {
  it('derives a 60 bit grouped code and stays deterministic', () => {
    expect(PAIRING_SAS_BITS).toBe(60)
    const code = derivePairingSas({ hostPublicKey: host.publicKey, clientPublicKey: controller.publicKey, nonce })
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u)
    expect(code.replace(/-/gu, '')).toHaveLength(PAIRING_SAS_CHARS)
    expect(derivePairingSas({ hostPublicKey: host.publicKey, clientPublicKey: controller.publicKey, nonce })).toBe(code)
  })

  it('changes with every input, including which side is which', () => {
    const base = { hostPublicKey: host.publicKey, clientPublicKey: controller.publicKey, nonce }
    const code = derivePairingSas(base)
    expect(derivePairingSas({ ...base, nonce: createPairingNonce() })).not.toBe(code)
    expect(derivePairingSas({ ...base, clientPublicKey: generateKeyPair().publicKey })).not.toBe(code)
    expect(derivePairingSas({ ...base, hostPublicKey: controller.publicKey, clientPublicKey: host.publicKey })).not.toBe(code)
  })

  it('normalizes human typing and compares without leaking a prefix match', () => {
    const code = derivePairingSas({ hostPublicKey: host.publicKey, clientPublicKey: controller.publicKey, nonce })
    expect(normalizePairingCode(code.toLowerCase())).toBe(code)
    expect(normalizePairingCode(` ${code.replace(/-/gu, ' ')} `)).toBe(code)
    expect(pairingSasMatches(code, code.toLowerCase())).toBe(true)
    // A short code is rejected as malformed rather than compared.
    expect(() => pairingSasMatches(code, code.slice(0, -1))).toThrow(PairingCodeError)
    expect(pairingSasMatches(code, code.replace(/.$/, char => (char === 'A' ? 'B' : 'A')))).toBe(false)
    expect(() => normalizePairingCode('ABC')).toThrow(PairingCodeError)
  })

  it('rejects non-32-byte keys instead of deriving from junk', () => {
    expect(() => derivePairingSas({
      hostPublicKey: toBase64Url(new Uint8Array(16)),
      clientPublicKey: controller.publicKey,
      nonce,
    })).toThrow(PairingCodeError)
  })

  it('creates a 32-byte nonce and rejects a short one', () => {
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
    expect(createPairingNonce()).not.toBe(nonce)
    expect(() => createPairingNonce(() => new Uint8Array(4))).toThrow(PairingCodeError)
  })
})
