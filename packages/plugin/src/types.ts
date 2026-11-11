import type { RemoteMessage } from '@dsh-remote/protocol'

export interface AuthenticatedPeerChannel {
  /**
   * Attestation supplied by the Noise/control-plane integration. Implementors
   * must expose this channel only after both the Noise IK transcript and the
   * Server membership for this exact connection have been verified.
   */
  readonly security: {
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256'
    connectionId: string
    membershipId: string
  }
  readonly peerDeviceId: string
  readonly peerIdentityKey: string
  readonly mode?: 'LAN' | 'P2P' | 'TURN' | 'Relay'
  send(message: RemoteMessage): Promise<void>
  onMessage(handler: (message: RemoteMessage) => void): () => void
  close(code?: string): Promise<void>
  /**
   * Enables secure-message compression (DSHZ frames) for this connection,
   * after the peer negotiated `harness.remote.compress.v1` via
   * `remote.compression.configure`. Optional: channels built without a
   * compressor never advertise the capability.
   */
  enableCompression?(): void
}
