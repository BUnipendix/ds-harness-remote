import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { ClientModeRuntime } from '../src/client-runtime.js'
import type { ClientConnection } from '../src/client-connection.js'
import type { ConnectedRemote } from '../src/client-runtime-contract.js'
import { resolveConfig } from '../src/config.js'
import { IdentityStore } from '../src/identity-store.js'
import { SafeLogger } from '../src/logging.js'
import type { ClientServerApi } from '../src/server-api.js'
import { remoteDiscoveryTools, type RemoteDiscoveryClient } from '../src/remote-tools.js'

const cleanups: Array<() => Promise<unknown>> = []
async function cleanup() {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
}
afterEach(cleanup)

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remote-tools-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const gateway = { invoke: vi.fn(), dispatchRpc: vi.fn(), openWireStream: vi.fn() }
  const server = { bindIdentity: vi.fn(), revokeCurrentDevice: vi.fn() }
  const runtime = new ClientModeRuntime(resolveConfig({ serverUrl: 'https://example.com' }),
    new IdentityStore({ directory }), server as unknown as ClientServerApi, gateway,
    new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} }, 'error'))
  await runtime.start()
  cleanups.push(() => runtime.close())
  const state = runtime as unknown as { connection: ClientConnection; connected?: ConnectedRemote }
  return { runtime, state }
}

describe('Remote discovery authority and lifecycle', () => {
  it('projects only online Host metadata and rejects mutation-shaped input before dispatch', async () => {
    const client = {
      devices: vi.fn(async () => [
        { deviceId: 'online', online: true, name: 'Host', platform: 'linux', membershipId: 'private-membership', identityKey: 'secret' },
        { deviceId: 'offline', online: false, name: 'Offline', platform: 'linux', membershipId: 'member' },
      ]),
      discoverToolWorkspaces: vi.fn(),
    }
    const [hosts, workspaces] = remoteDiscoveryTools(() => client)
    const exec = { signal: new AbortController().signal }
    expect(await hosts!.execute({}, exec)).toEqual({ hosts: [{ hostId: 'online', name: 'Host', platform: 'linux' }] })
    for (const args of [{ hostId: '' }, { hostId: 'online', method: 'session/create' }, { hostId: 'online', path: '/tmp' }]) {
      expect(() => workspaces!.execute(args, exec)).toThrow()
    }
    expect(client.discoverToolWorkspaces).not.toHaveBeenCalled()
    const aborted = AbortSignal.abort()
    await expect(workspaces!.execute({ hostId: 'online' }, { signal: aborted })).rejects.toThrow()
    expect(client.discoverToolWorkspaces).not.toHaveBeenCalled()
  })

  it('discards stale authority results and never exposes upstream error details', async () => {
    await runScenarios(['replace', 'error', 'cancel'].map(action => ({ name: action, run: async () => {
      let finish!: (value: never[]) => void
      const controller = new AbortController()
      let current: RemoteDiscoveryClient | undefined = {
        devices: vi.fn(() => action === 'error' ? Promise.reject(new Error('token=secret')) : new Promise<never[]>(resolve => { finish = resolve })),
        discoverToolWorkspaces: vi.fn(),
      }
      const tool = remoteDiscoveryTools(() => current)[0]!
      const pending = tool.execute({}, { signal: controller.signal })
      if (action === 'replace') current = undefined
      if (action === 'cancel') controller.abort()
      if (action !== 'error') finish([])
      await expect(pending).rejects.toThrow()
      await pending.catch(error => expect(String(error)).not.toContain('token=secret'))
    } })))
  })

  it('routes concurrent catalogs to their own temporary carriers and leaves the UI connection intact', async () => {
    const { runtime, state } = await fixture()
    const ui = { client: { close: vi.fn() }, target: { deviceId: 'ui-host' } } as unknown as ConnectedRemote
    state.connected = ui
    const carriers: Array<{ close: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> }> = []
    const connect = vi.spyOn(state.connection, 'connect').mockImplementation(async hostId => {
      const client = {
        close: vi.fn(async () => undefined),
        rpc: vi.fn(async (_method, request) => {
          if (request.params.backend === 'cursor') throw new Error('private backend error')
          return [{ path: `/${hostId}/project`, title: hostId }]
        }),
      }
      carriers.push(client)
      return { client, target: { deviceId: hostId }, features: { antigravity: true, cursor: true } } as unknown as ConnectedRemote
    })
    const results = await Promise.all(['host-a', 'host-b'].map(hostId => runtime.discoverToolWorkspaces(hostId, new AbortController().signal)))
    for (const [index, hostId] of ['host-a', 'host-b'].entries()) {
      expect(results[index]).toEqual({
        workspaces: [{ backend: 'antigravity', workspaceId: `antigravity:cwd:${encodeURIComponent(`/${hostId}/project`)}`, path: `/${hostId}/project`, title: hostId }],
        unavailable: [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }],
      })
      expect(connect.mock.calls[index]?.[2]).toEqual({ background: true })
    }
    for (const carrier of carriers) {
      expect(carrier.close).toHaveBeenCalledOnce()
      expect(carrier.rpc.mock.calls.every(([method, request]) => method === 'agent.acp.call' && request.method === 'dsh/workspaceList')).toBe(true)
    }
    expect(state.connected).toBe(ui)
    expect(ui.client.close).not.toHaveBeenCalled()
    state.connected = undefined
  })

  it('closes late discovery carriers after caller cancellation, sign-out or shutdown', async () => {
    await runScenarios(['cancel', 'sign-out', 'shutdown'].map(action => ({ name: action, run: async () => {
      const { runtime, state } = await fixture()
      let finish!: (remote: ConnectedRemote) => void
      vi.spyOn(state.connection, 'connect').mockImplementation(() => new Promise(resolve => { finish = resolve }))
      const controller = new AbortController()
      const pending = runtime.discoverToolWorkspaces('host', controller.signal)
      const rejected = expect(pending).rejects.toThrow()
      if (action === 'cancel') controller.abort()
      else if (action === 'sign-out') await runtime.clearClientAuthorization()
      else await runtime.close()
      const close = vi.fn(async () => undefined)
      const rpc = vi.fn()
      finish({ client: { close, rpc }, features: { antigravity: true } } as unknown as ConnectedRemote)
      await rejected
      expect(close).toHaveBeenCalledOnce()
      expect(rpc).not.toHaveBeenCalled()
    } })), cleanup)
  })
})
