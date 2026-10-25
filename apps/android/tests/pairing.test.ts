import { createPairingOffer, derivePairingSas, generateKeyPair } from '@dsh-remote/crypto'
import { describe, expect, it, vi } from 'vitest'

// The trust store pulls in Expo native modules, which this runner cannot parse.
vi.mock('../src/services/storage', () => ({ trustHost: vi.fn(async () => undefined) }))

const { pairWithOffer, pairingCodeFor } = await import('../src/services/pairing')
const { trustHost } = await import('../src/services/storage')

/**
 * The phone must derive exactly the code the Harness derives from the same QR
 * payload; otherwise the operator comparison always fails.
 */
describe('Android pairing code', () => {
  const host = generateKeyPair()
  const phone = generateKeyPair()

  it('matches the shared derivation for the same offer', () => {
    const { offer, uri } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: host.publicKey })
    const result = pairingCodeFor(uri, { publicKey: phone.publicKey })
    expect(result.hostDeviceId).toBe('host-1')
    expect(result.confirmationCode).toBe(derivePairingSas({
      hostPublicKey: host.publicKey,
      clientPublicKey: phone.publicKey,
      nonce: offer.nonce,
    }))
  })

  it('rejects an expired or foreign payload before touching the trust store', () => {
    const { uri } = createPairingOffer({ hostDeviceId: 'host-1', hostPublicKey: host.publicKey, ttlMs: 1_000 })
    expect(() => pairingCodeFor(uri, { publicKey: phone.publicKey }, Date.now() + 60_000)).toThrow()
    expect(() => pairingCodeFor('https://example.com', { publicKey: phone.publicKey })).toThrow()
  })

  it('includes the Host name when the offer carries one', () => {
    const { uri } = createPairingOffer({
      hostDeviceId: 'host-1',
      hostDeviceName: 'Workstation',
      hostPublicKey: host.publicKey,
    })
    expect(pairingCodeFor(uri, { publicKey: phone.publicKey }).hostDeviceName).toBe('Workstation')
  })
})

describe('Android pairing trust write', () => {
  it('pins the scanned key as an out-of-band pairing', async () => {
    const host = generateKeyPair()
    const phone = generateKeyPair()
    const { uri } = createPairingOffer({ hostDeviceId: 'host-9', hostPublicKey: host.publicKey })
    await pairWithOffer(uri, { publicKey: phone.publicKey })
    expect(trustHost).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'host-9', identityKey: host.publicKey, trusted: true }),
      { verification: 'pairing' },
    )
  })
})
