import {
  derivePairingSas,
  fromBase64Url,
  identityFingerprint,
  parsePairingOffer,
  toBase64Url,
} from '@dsh-remote/crypto'
import type { RemoteDevice } from '../types'
import { strings } from '../locales/i18n'
import { trustHost } from './storage'

/**
 * Out-of-band pairing on Android.
 *
 * The Controller scans a QR code that the Harness side renders locally, pins the
 * Harness identity key from that payload (never from a Server descriptor), and
 * shows the confirmation code for a comparison on the other screen.
 *
 * Everything here is derived from the QR payload plus this phone's own key, so a
 * hostile Server cannot influence the result.
 */

export interface PairingIdentity {
  /** This phone's X25519 public key, base64url. */
  publicKey: string
}

export interface PairingResult {
  hostDeviceId: string
  hostDeviceName?: string
  /** Code to compare with the Harness screen, formatted `XXXX-XXXX-XXXX`. */
  confirmationCode: string
  expiresAt: number
  fingerprint: string
}

export function pairingCodeFor(uri: string, identity: PairingIdentity, now = Date.now()): PairingResult {
  const offer = parsePairingOffer(uri, now)
  return {
    hostDeviceId: offer.hostDeviceId,
    ...(offer.hostDeviceName === undefined ? {} : { hostDeviceName: offer.hostDeviceName }),
    confirmationCode: derivePairingSas({
      hostPublicKey: offer.hostPublicKey,
      clientPublicKey: identity.publicKey,
      nonce: offer.nonce,
    }),
    expiresAt: offer.expiresAt,
    fingerprint: formatFingerprint(identityFingerprint(offer.hostPublicKey)),
  }
}

/**
 * Pin the scanned Host. Call {@link pairingCodeFor} first so an expired or
 * malformed code never reaches the trust store.
 */
export async function pairWithOffer(
  uri: string,
  identity: PairingIdentity,
  now = Date.now(),
): Promise<PairingResult> {
  const result = pairingCodeFor(uri, identity, now)
  const offer = parsePairingOffer(uri, now)
  const host: RemoteDevice = {
    deviceId: offer.hostDeviceId,
    name: offer.hostDeviceName ?? 'Harness',
    platform: 'unknown',
    identityKey: offer.hostPublicKey,
    membershipId: '',
    online: false,
    fingerprint: result.fingerprint,
    trusted: true,
  }
  await trustHost(host, { verification: 'pairing' })
  return result
}

/**
 * True when the Server descriptor for a paired Host still matches the pin.
 * A mismatch means the Host was re-registered with a new key: refuse it rather
 * than silently trusting the Server's version.
 */
export function pinnedKeyMatches(pinned: string | undefined, descriptorKey: string): boolean {
  if (pinned === undefined || pinned.length === 0) return false
  try {
    return toBase64Url(fromBase64Url(pinned)) === toBase64Url(fromBase64Url(descriptorKey))
  } catch {
    return false
  }
}

/**
 * Localize a pairing failure.
 *
 * The crypto package raises codes with English messages (`PAIRING_EXPIRED`,
 * `PAIRING_INVALID_KEY`, …). Those are fine for logs, but the pairing screen
 * shows the sentence to the operator, so every known code maps to copy.
 */
export function pairingErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'PAIRING_EXPIRED') return strings.pairing.errorExpired
  if (code === 'SAS_INVALID') return strings.pairing.errorSas
  if (typeof code === 'string' && code.startsWith('PAIRING_INVALID')) return strings.pairing.errorInvalid
  // Anything else is unexpected: keep the message, since a generic sentence
  // would hide a real fault.
  return error instanceof Error ? error.message : String(error)
}

function formatFingerprint(value: string): string {
  return value.match(/.{1,4}/g)?.join(' ') ?? value
}
