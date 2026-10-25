import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fromBase64Url, generateKeyPair } from '@dsh-remote/crypto'
import { z } from 'zod'
import { uuidV7 } from './ids.js'

const identitySchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(80),
  publicKey: z.string().min(1),
}).strict()

/**
 * How a peer key became trusted.
 *
 * - `pairing` / `user`: the key reached the trust store through an out-of-band
 *   channel (pairing payload or an explicit human confirmation), so the Server
 *   never had a chance to substitute it.
 * - `unverified`: the key came from the Server device descriptor on first
 *   contact. Legacy records without this field load as `unverified`.
 */
export type PeerVerification = 'pairing' | 'user' | 'unverified'

const peerVerificationSchema = z.enum(['pairing', 'user', 'unverified'])

const trustedPeerSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  publicKey: z.string().min(1),
  fingerprint: z.string().min(1),
  trustedAt: z.number().int().nonnegative(),
  membershipId: z.string().min(1).optional(),
  verification: peerVerificationSchema.default('unverified'),
}).strict()

const trustedPeersSchema = z.object({
  schemaVersion: z.literal(1),
  peers: z.array(trustedPeerSchema),
}).strict()

export interface HostIdentity {
  schemaVersion: 1
  deviceId: string
  name: string
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface TrustedPeer {
  deviceId: string
  name: string
  platform: string
  publicKey: string
  fingerprint: string
  trustedAt: number
  membershipId?: string
  verification: PeerVerification
}

/** Peer fields callers supply; `verification` defaults to `unverified`. */
export type TrustPeerInput = Omit<TrustedPeer, 'fingerprint' | 'trustedAt' | 'verification'> & {
  verification?: PeerVerification
}

export interface IdentityStoreOptions {
  directory?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

export type RemoteDeviceRole = 'host' | 'client'

export class IdentityInvalidError extends Error {
  readonly code = 'IDENTITY_INVALID'
}

export class IdentityStore {
  readonly directory: string
  private identity?: HostIdentity
  private peers = new Map<string, TrustedPeer>()

  constructor(options: IdentityStoreOptions = {}) {
    const env = options.env ?? process.env
    const dshHome = env.DSH_HOME || join(options.homeDirectory ?? homedir(), '.dsh')
    this.directory = options.directory ?? join(dshHome, 'remote')
  }

  async loadOrCreate(deviceName: string): Promise<HostIdentity> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const devicePath = join(this.directory, 'device.json')
    const keyPath = join(this.directory, 'device.key')
    const [hasDevice, hasKey] = await Promise.all([exists(devicePath), exists(keyPath)])
    if (hasDevice !== hasKey) {
      throw new IdentityInvalidError('device identity is incomplete; repair it explicitly before reconnecting')
    }

    if (!hasDevice) {
      const keys = generateKeyPair()
      const record = { schemaVersion: 1 as const, deviceId: uuidV7(), name: deviceName, publicKey: keys.publicKey }
      await atomicJsonWrite(devicePath, record, 0o600)
      await atomicTextWrite(keyPath, `${keys.privateKey}\n`, 0o600)
    }

    await assertPrivateMode(keyPath)
    try {
      let record = identitySchema.parse(JSON.parse(await readFile(devicePath, 'utf8')))
      const privateKey = (await readFile(keyPath, 'utf8')).trim()
      const regenerated = generateKeyPair(fromBase64Url(privateKey))
      if (regenerated.publicKey !== record.publicKey) {
        throw new IdentityInvalidError('device public and private keys do not match')
      }
      if (record.name !== deviceName) {
        record = { ...record, name: deviceName }
        await atomicJsonWrite(devicePath, record, 0o600)
      }
      this.identity = { ...record, privateKey, fingerprint: fingerprint(record.publicKey) }
      await this.loadPeers()
      return this.identity
    } catch (error: unknown) {
      if (error instanceof IdentityInvalidError) throw error
      throw new IdentityInvalidError(`device identity is invalid: ${safeErrorMessage(error)}`)
    }
  }

  current(): HostIdentity {
    if (this.identity === undefined) throw new Error('identity store has not been loaded')
    return this.identity
  }

  async reset(deviceName: string): Promise<HostIdentity> {
    await rm(this.directory, { recursive: true, force: true })
    this.identity = undefined
    this.peers.clear()
    return this.loadOrCreate(deviceName)
  }

  listTrustedPeers(): TrustedPeer[] {
    return [...this.peers.values()].map(peer => ({ ...peer }))
  }

  trustedPeer(deviceId: string): TrustedPeer | undefined {
    const peer = this.peers.get(deviceId)
    return peer === undefined ? undefined : { ...peer }
  }

  isTrusted(deviceId: string, publicKey: string): boolean {
    return this.peers.get(deviceId)?.publicKey === publicKey
  }

  /**
   * Record a peer key that came from a Server device descriptor.
   *
   * Such a key only ever reaches `unverified`, and it can never downgrade or
   * replace a key that was pinned out-of-band.
   */
  async trustPeer(input: TrustPeerInput): Promise<TrustedPeer> {
    return await this.recordPeer(input, false)
  }

  /**
   * Pin a peer key that arrived out-of-band (pairing payload or an explicit
   * human confirmation). Only this path can mark a peer as verified, and only
   * `replace` may change an already-pinned key.
   */
  async pinPeer(
    input: TrustPeerInput & { verification: Exclude<PeerVerification, 'unverified'> },
    options: { replace?: boolean } = {},
  ): Promise<TrustedPeer> {
    // Runtime guard for untyped callers; the signature already excludes it.
    if ((input.verification as PeerVerification) === 'unverified') {
      throw new IdentityInvalidError('pinPeer requires an out-of-band verification source')
    }
    return await this.recordPeer(input, options.replace === true)
  }

  /** True when the local pin did not come from the Server. */
  isVerified(deviceId: string): boolean {
    return this.peers.get(deviceId)?.verification !== undefined
      && this.peers.get(deviceId)?.verification !== 'unverified'
  }

  private async recordPeer(input: TrustPeerInput, replace: boolean): Promise<TrustedPeer> {
    this.current()
    const existing = this.peers.get(input.deviceId)
    if (existing !== undefined && existing.publicKey !== input.publicKey && !replace) {
      throw new IdentityInvalidError(`trusted peer ${input.deviceId} is already pinned to a different key`)
    }
    const peer: TrustedPeer = {
      ...input,
      verification: resolveVerification(existing, input, replace),
      fingerprint: fingerprint(input.publicKey),
      trustedAt: Date.now(),
    }
    this.peers.set(peer.deviceId, peer)
    await this.savePeers()
    return { ...peer }
  }

  async revokePeer(deviceId: string): Promise<boolean> {
    const removed = this.peers.delete(deviceId)
    if (removed) await this.savePeers()
    return removed
  }

  private async loadPeers(): Promise<void> {
    const path = join(this.directory, 'trusted-peers.json')
    if (!(await exists(path))) {
      await atomicJsonWrite(path, { schemaVersion: 1, peers: [] }, 0o600)
    }
    const parsed = trustedPeersSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const peers = new Map<string, TrustedPeer>()
    for (const peer of parsed.peers) {
      if (peer.fingerprint !== fingerprint(peer.publicKey)) {
        throw new IdentityInvalidError(`trusted peer ${peer.deviceId} has an invalid fingerprint`)
      }
      if (peers.has(peer.deviceId)) throw new IdentityInvalidError(`trusted peer ${peer.deviceId} is duplicated`)
      peers.set(peer.deviceId, peer)
    }
    this.peers = peers
  }

  private async savePeers(): Promise<void> {
    await atomicJsonWrite(join(this.directory, 'trusted-peers.json'), {
      schemaVersion: 1,
      peers: [...this.peers.values()],
    }, 0o600)
  }
}

export function serverStorageDirectory(root: string, serverUrl: string, role: RemoteDeviceRole): string {
  const origin = new URL(serverUrl).origin
  const scope = createHash('sha256').update(origin).digest('hex').slice(0, 24)
  return join(root, 'servers', scope, role)
}

/**
 * A Server-sourced update may never weaken or clear an out-of-band pin.
 * Unspecified verification therefore inherits the existing state when the key
 * is unchanged, and defaults to `unverified` for a brand-new peer.
 */
function resolveVerification(existing: TrustedPeer | undefined, input: TrustPeerInput, replace: boolean): PeerVerification {
  const requested = input.verification ?? 'unverified'
  const samePeer = existing !== undefined && existing.publicKey === input.publicKey && !replace
  if (samePeer && requested === 'unverified') return existing.verification
  return requested
}

export function fingerprint(publicKey: string): string {
  const compact = createHash('sha256').update(fromBase64Url(publicKey)).digest('hex').slice(0, 12).toUpperCase()
  return compact.match(/.{1,4}/g)!.join(' ')
}

async function assertPrivateMode(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new IdentityInvalidError(`private key permissions must be 0600, got ${mode.toString(8).padStart(3, '0')}`)
  }
}

async function atomicJsonWrite(path: string, value: unknown, mode: number): Promise<void> {
  await atomicTextWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

async function atomicTextWrite(path: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode, flag: 'wx' })
  await chmod(temporary, mode)
  await rename(temporary, path)
  await chmod(path, mode)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid identity data'
}
