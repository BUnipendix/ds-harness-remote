import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoisePrologue, generateKeyPair, NoiseIkSession, toBase64Url } from '@dsh-remote/crypto'
import { createControlFrame } from '@dsh-remote/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import { deriveSas, parsePairingOffer } from '../src/pairing.js'
import { HostServerConnection } from '../src/server-connection.js'

/**
 * Pairing flow on the Host side: an unconfirmed peer may finish Noise so a
 * confirmation code can be derived from the key that actually arrived, but it
 * stays out of the connection controller (no RPC, no events) until the operator
 * types the code shown on the other device.
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
    role: 'host',
    serverUrl: 'https://remote.test',
    deviceName: 'Host',
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
  frames(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.sent.map(text => JSON.parse(text) as { type: string; payload: Record<string, unknown> })
  }
}

const hostKeys = generateKeyPair()
const peerKeys = generateKeyPair()
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

async function setup(options: { requireVerifiedPeer?: boolean; withOffer?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pairing-host-'))
  directories.push(directory)
  const store = new IdentityStore({ directory })
  await store.loadOrCreate('Host')
  const socket = new FakeSocket()
  const accept = vi.fn(async () => undefined)
  const server = new HostServerConnection(
    config(options.requireVerifiedPeer ?? true),
    { schemaVersion: 1, deviceId: 'host-1', name: 'Host', fingerprint: 'HOST', ...hostKeys },
    store,
    {
      baseUrl: 'https://remote.test',
      authenticate: async () => ({ accessToken: 'token' }),
      deviceFor: async () => ({
        deviceId: 'client-1', name: 'Phone', platform: 'android', role: 'client' as const,
        identityKey: peerKeys.publicKey, membershipId: 'membership-1',
      }),
      turnCredentials: async () => [],
    } as never,
    { accept, close: async () => undefined, closeConnection: async () => true } as never,
    logger(),
    () => socket as never,
  )
  server.start()
  await settle()
  socket.open()
  socket.receive(createControlFrame('hello.ack', {
    protocol: 1,
    serverVersion: '0.1.0',
    connectionSessionId: 'control-1',
    heartbeatIntervalMs: 25_000,
    maxControlFrameBytes: 65_536,
    maxRelayFrameBytes: 1_048_576,
  }))
  const offer = options.withOffer === false ? undefined : server.beginPairing()
  return { server, socket, store, accept, offer }
}

function incoming(socket: FakeSocket, connectionId = 'connection-1'): void {
  socket.receive(createControlFrame('connect.incoming', {
    connectionId,
    clientDeviceId: 'client-1',
    clientIdentityKey: peerKeys.publicKey,
    authorization: 'account',
    preferredTransports: ['relay'],
  }))
}

async function driveHandshake(socket: FakeSocket, connectionId = 'connection-1'): Promise<void> {
  const noise = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: peerKeys.privateKey,
    localPublicKey: peerKeys.publicKey,
    remotePublicKey: hostKeys.publicKey,
    prologue: createNoisePrologue(connectionId, 'host-1', 'client-1'),
  })
  socket.receive(createControlFrame('secure.handshake', {
    connectionId,
    targetDeviceId: 'host-1',
    step: 1,
    data: toBase64Url(noise.writeHandshake()),
  }))
  await settle()
}

describe('host pairing flow', () => {
  it('rejects an unpaired peer when no pairing offer is open', async () => {
    const { server, socket, store } = await setup({ withOffer: false })
    try {
      incoming(socket)
      await settle()
      expect(socket.frames().some(frame => frame.type === 'connect.rejected')).toBe(true)
      expect(store.trustedPeer('client-1')).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('holds the tunnel out of the connection controller until the code is confirmed', async () => {
    const { server, socket, store, accept, offer } = await setup()
    try {
      expect(offer).toBeDefined()
      incoming(socket)
      await settle()
      await driveHandshake(socket)

      // Authenticated, but no business routing and no persisted pin yet.
      expect(accept).not.toHaveBeenCalled()
      expect(store.trustedPeer('client-1')).toBeUndefined()
      const nonce = parsePairingOffer(offer!.uri).nonce
      const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: peerKeys.publicKey, nonce })
      // The comparison code must be exactly the value derived from the key that
      // arrived, so the operator can match it against the Controller screen.
      expect(server.pendingPairing()).toMatchObject({ peerDeviceId: 'client-1', code: sas })
      await expect(server.confirmPairing(sas)).resolves.toEqual({ status: 'pinned', peerDeviceId: 'client-1' })
      expect(store.trustedPeer('client-1')?.verification).toBe('pairing')
      // Confirming hands the authenticated channel over, so the Controller does
      // not have to reconnect after the operator approves the code.
      expect(accept).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('keeps the confirmation code when the Server drops the idle tunnel', async () => {
    // The Server closes an idle verifying connection long before a human walks
    // to the Host screen, and the code is derived from the pairing nonce plus
    // both static keys, so the operator must still be able to confirm it.
    const { server, socket, store, offer } = await setup()
    try {
      incoming(socket)
      await settle()
      await driveHandshake(socket)
      const nonce = parsePairingOffer(offer!.uri).nonce
      const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: peerKeys.publicKey, nonce })

      socket.receive(createControlFrame('error', {
        code: 'CONNECTION_FAILED',
        message: 'the Server closed the idle connection',
        retryable: true,
        connectionId: 'connection-1',
      }))
      await settle()

      expect(server.pendingPairing()).toMatchObject({ peerDeviceId: 'client-1', code: sas })
      await expect(server.confirmPairing(sas)).resolves.toEqual({ status: 'pinned', peerDeviceId: 'client-1' })
      expect(store.trustedPeer('client-1')?.verification).toBe('pairing')
    } finally {
      await server.stop()
    }
  })

  it('refuses a code that does not match the key that arrived, and burns the offer after three tries', async () => {
    const { server, socket, store, offer } = await setup()
    try {
      incoming(socket)
      await settle()
      await driveHandshake(socket)
      const nonce = parsePairingOffer(offer!.uri).nonce
      const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: peerKeys.publicKey, nonce })
      const wrong = sas.replace(/.$/, char => (char === 'A' ? 'B' : 'A'))

      await expect(server.confirmPairing(wrong)).rejects.toMatchObject({ code: 'SAS_MISMATCH' })
      expect(store.trustedPeer('client-1')).toBeUndefined()
      expect(server.pendingPairing()).toMatchObject({ attemptsLeft: 2 })

      await expect(server.confirmPairing(wrong)).rejects.toMatchObject({ code: 'SAS_MISMATCH' })
      await expect(server.confirmPairing(wrong)).rejects.toMatchObject({ code: 'SAS_MISMATCH' })
      expect(server.pendingPairing()).toBeUndefined()
      // The offer is burned: even the correct code no longer applies.
      await expect(server.confirmPairing(sas)).rejects.toMatchObject({ code: 'PAIRING_NONE' })
    } finally {
      await server.stop()
    }
  })
})

describe('host pairing lifetime', () => {
  it('expires the waiting tunnel when the offer lifetime ends', async () => {
    const { server, socket } = await setup()
    try {
      incoming(socket)
      await settle()
      await driveHandshake(socket)
      expect(server.pendingPairing()).toBeDefined()

      expect(await server.expirePairing(Date.now() + 6 * 60_000)).toBe(true)
      expect(server.pendingPairing()).toBeUndefined()
      expect(await server.expirePairing(Date.now() + 6 * 60_000)).toBe(false)
    } finally {
      await server.stop()
    }
  })
})

describe('host pairing is exclusive and sticky', () => {
  it('rejects a second unverified connection while one pairing is pending', async () => {
    const { server, socket, offer } = await setup()
    try {
      expect(offer).toBeDefined()
      incoming(socket)
      await settle()
      await driveHandshake(socket)
      expect(server.pendingPairing()).toBeDefined()

      incoming(socket, 'connection-2')
      await settle()
      const rejected = socket.frames()
        .filter(frame => frame.type === 'connect.rejected')
        .map(frame => frame.payload.connectionId)
      expect(rejected).toContain('connection-2')
    } finally {
      await server.stop()
    }
  })

  it('accepts the next connection normally once the peer is pinned', async () => {
    const { server, socket, store, accept, offer } = await setup()
    try {
      incoming(socket)
      await settle()
      await driveHandshake(socket)
      const nonce = parsePairingOffer(offer!.uri).nonce
      const sas = deriveSas({ hostPublicKey: hostKeys.publicKey, clientPublicKey: peerKeys.publicKey, nonce })
      await server.confirmPairing(sas)

      incoming(socket, 'connection-3')
      await settle()
      await driveHandshake(socket, 'connection-3')
      expect(store.trustedPeer('client-1')?.verification).toBe('pairing')
      // One hand-off for the confirmed tunnel, one for the pinned peer that
      // reconnects without any pairing offer.
      expect(accept).toHaveBeenCalledTimes(2)
      expect(server.pendingPairing()).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})
