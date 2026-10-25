import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@dsh-remote/crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientModeRuntime } from '../src/client-runtime.js'
import type { ResolvedConfig } from '../src/config.js'
import { IdentityInvalidError, IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import type { ClientServerApi, ServerHostDevice } from '../src/server-api.js'
import { createPairingOffer, deriveSas, parsePairingOffer } from '../src/pairing.js'

/**
 * Regression coverage for the remote identity threat model.
 *
 * The Server is the only source of peer public keys today. When it is hostile
 * it can hand either side its own key and terminate a Noise IK handshake on
 * both legs, which is a silent man-in-the-middle. Only a key that reached the
 * trust store out of band can rule that out, so `requireVerifiedPeer` must
 * refuse a Server-sourced key outright instead of pinning it.
 */

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function config(requireVerifiedPeer: boolean): ResolvedConfig {
  return {
    terminal: { enabled: false },
    loopback: { ports: [] },
    enabled: true,
    role: 'client',
    serverUrl: 'https://remote.test',
    deviceName: 'Client',
    forceRelay: true,
    identity: { requireVerifiedPeer },
    logLevel: 'error',
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 },
    codex: { enabled: false, binary: 'codex' },
    cursor: { enabled: false, binary: 'agent' },
  }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

const listed: ServerHostDevice = {
  deviceId: 'host-1',
  name: 'Host',
  platform: 'linux',
  membershipId: 'membership-1',
}

/** A Host key that the Server, not the user, chose. */
const attacker = generateKeyPair()

function serverWith(key: string): ClientServerApi {
  return {
    baseUrl: 'https://remote.test',
    bindIdentity: vi.fn(),
    deviceFor: async () => ({ ...listed, role: 'host' as const, identityKey: key }),
    presenceFor: async () => ({ online: true }),
  } as unknown as ClientServerApi
}

async function runtime(requireVerifiedPeer: boolean, key: string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-e2ee-mitm-'))
  directories.push(directory)
  const instance = new ClientModeRuntime(
    config(requireVerifiedPeer),
    new IdentityStore({ directory }),
    serverWith(key),
    undefined,
    { invoke: vi.fn(async () => undefined) } as never,
    logger(),
  )
  await instance.start()
  const connection = (instance as unknown as {
    connection: { authorizeHostPeer(device: ServerHostDevice): Promise<{ publicKey: string; verification: string }> }
  }).connection
  return { instance, connection, directory }
}

describe('remote identity: hostile Server cannot supply the peer key', () => {
  it('records a Server-supplied Host key as unverified when the policy is off', async () => {
    const { instance, connection } = await runtime(false, attacker.publicKey)
    try {
      const peer = await connection.authorizeHostPeer(listed)
      // Documents the exposure this policy exists to close: the key the Server
      // chose became the pinned key, so a MITM would never be detected.
      expect(peer.publicKey).toBe(attacker.publicKey)
      expect(peer.verification).toBe('unverified')
    } finally {
      await instance.close()
    }
  })

  it('refuses a Server-supplied Host key when verified peers are required', async () => {
    const { instance, connection } = await runtime(true, attacker.publicKey)
    try {
      await expect(connection.authorizeHostPeer(listed)).rejects.toMatchObject({ code: 'PEER_UNVERIFIED' })
    } finally {
      await instance.close()
    }
  })
})

describe('remote identity: Server descriptors cannot weaken an out-of-band pin', () => {
  it('keeps pairing verification when a later descriptor matches the pinned key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-e2ee-pin-'))
    directories.push(directory)
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Client')
    const host = generateKeyPair()
    await store.pinPeer({
      deviceId: 'host-1',
      name: 'Host',
      platform: 'linux',
      publicKey: host.publicKey,
      membershipId: 'membership-1',
      verification: 'pairing',
    })
    const updated = await store.trustPeer({
      deviceId: 'host-1',
      name: 'Host renamed',
      platform: 'linux',
      publicKey: host.publicKey,
      membershipId: 'membership-1',
    })
    expect(updated.verification).toBe('pairing')
    expect(store.isVerified('host-1')).toBe(true)
  })

  it('refuses to replace a pinned key with a different Server-supplied key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-e2ee-swap-'))
    directories.push(directory)
    const store = new IdentityStore({ directory })
    await store.loadOrCreate('Client')
    const host = generateKeyPair()
    await store.pinPeer({
      deviceId: 'host-1',
      name: 'Host',
      platform: 'linux',
      publicKey: host.publicKey,
      verification: 'pairing',
    })
    await expect(store.trustPeer({
      deviceId: 'host-1',
      name: 'Host',
      platform: 'linux',
      publicKey: attacker.publicKey,
    })).rejects.toBeInstanceOf(IdentityInvalidError)
  })
})

/**
 * Host side of the same threat: the Server decides which Client key the Host
 * sees, so an unpaired Client key must be rejected instead of silently pinned.
 */
describe('remote identity: the Host does not accept a Server-supplied Client key', () => {
  class FakeSocket {
    readyState = 0
    sent: string[] = []
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null
    open(): void { this.readyState = 1; this.onopen?.({}) }
    receive(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }) }
    send(data: string): void { this.sent.push(data) }
    close(code = 1000, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }) }
  }

  it('rejects connect.incoming for an unpaired Client identity', async () => {
    const { HostServerConnection } = await import('../src/server-connection.js')
    const { createControlFrame } = await import('@dsh-remote/protocol')
    const hostKeys = generateKeyPair()
    const socket = new FakeSocket()
    const server = new HostServerConnection(
      { ...config(true), role: 'host' },
      { schemaVersion: 1, deviceId: 'host-1', name: 'Host', fingerprint: 'HOST', ...hostKeys },
      { trustedPeer: () => undefined } as unknown as IdentityStore,
      {
        baseUrl: 'https://remote.test',
        authenticate: async () => ({ accessToken: 'token' }),
        deviceFor: async () => ({
          deviceId: 'client-1', name: 'Client', platform: 'linux', role: 'client' as const,
          identityKey: attacker.publicKey, membershipId: 'membership-1',
        }),
        turnCredentials: async () => [],
      } as never,
      { close: async () => undefined } as never,
      logger(),
      () => socket as never,
    )
    try {
      server.start()
      await new Promise(resolve => setTimeout(resolve, 0))
      socket.open()
      socket.receive(createControlFrame('hello.ack', {
        protocol: 1,
        serverVersion: '0.1.0',
        connectionSessionId: 'control-1',
        heartbeatIntervalMs: 25_000,
        maxControlFrameBytes: 65_536,
        maxRelayFrameBytes: 1_048_576,
      }))
      socket.receive(createControlFrame('connect.incoming', {
        connectionId: 'connection-1',
        clientDeviceId: 'client-1',
        clientIdentityKey: attacker.publicKey,
        authorization: 'account',
        preferredTransports: ['relay'],
      }))
      for (let attempt = 0; attempt < 50 && !socket.sent.some(text => text.includes('connect.rejected')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const frames = socket.sent.map(text => JSON.parse(text) as { type: string; payload: { connectionId?: string } })
      expect(frames.some(frame =>
        frame.type === 'connect.rejected' && frame.payload.connectionId === 'connection-1')).toBe(true)
      expect(frames.some(frame => frame.type === 'connect.accepted')).toBe(false)
    } finally {
      await server.stop()
    }
  })
})


/**
 * Both ends must derive the same confirmation code from the QR payload and their
 * own key, otherwise pairing can never succeed.
 */
describe('pairing codes agree between the two devices', () => {
  it('derives the same code on the Host and on the Controller', async () => {
    const hostKeys = generateKeyPair()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pair-symmetry-'))
    directories.push(directory)
    const instance = new ClientModeRuntime(
      config(false),
      new IdentityStore({ directory }),
      { bindIdentity: vi.fn(), hasStoredAuthorization: async () => false } as unknown as ClientServerApi,
      undefined,
      { invoke: vi.fn(async () => undefined) } as never,
      logger(),
    )
    try {
      await instance.start()
      const controller = (instance as unknown as {
        identities: IdentityStore
      })
      const clientKeys = controller.identities.current()
      const { uri } = createPairingOffer({
        hostDeviceId: 'host-1',
        hostDeviceName: 'Workstation',
        hostPublicKey: hostKeys.publicKey,
      })
      const paired = await instance.pairWithOffer(uri)
      const nonce = parsePairingOffer(uri).nonce

      expect(paired.hostDeviceId).toBe('host-1')
      expect(paired.hostDeviceName).toBe('Workstation')
      // The Host computes it from the key that arrived on the tunnel; here that
      // is the Controller's advertised key.
      expect(paired.confirmationCode).toBe(deriveSas({
        hostPublicKey: hostKeys.publicKey,
        clientPublicKey: clientKeys.publicKey,
        nonce,
      }))
      expect(controller.identities.trustedPeer('host-1')?.verification).toBe('pairing')
    } finally {
      await instance.close()
    }
  })
})
