import { describe, expect, it, vi } from 'vitest'
import type { RemoteClientCore } from '@dsh-remote/client-core'
import { createEvent, encodeMessage, MAX_SECURE_MESSAGE_BYTES, MAX_HARNESS_API_TRANSFER_BYTES, TRANSFER_IDLE_MS, type EventPayload, type HarnessRemoteFrameData } from '@dsh-remote/protocol'
import { HarnessRemoteBridge } from '../src/harness-remote-bridge.js'
import { RemoteTypertGateway } from '../src/remote-typert-gateway.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'

function fixture(values: unknown[], capability = true) {
  const events: EventPayload[] = []
  const listeners = new Set<(event: EventPayload) => void>()
  const closeListeners = new Set<() => void>()
  const native: LocalTypertGateway = {
    supportsCarrier: true,
    invoke: async () => undefined,
    dispatch: async () => ({ ok: true }),
    open: async () => (async function* () { yield* values })(),
    failure: error => ({ code: 'internal', message: String(error), details: {} }),
  }
  const host = new HarnessRemoteBridge(native, async (event, data) => {
    expect(encodeMessage(createEvent(event, data)).byteLength).toBeLessThanOrEqual(MAX_SECURE_MESSAGE_BYTES)
    const frame = { event, data } as EventPayload
    events.push(frame)
    for (const listener of listeners) listener(frame)
  })
  const rpc = vi.fn(async (method: string, params: any, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted()
    switch (method) {
      case 'harness.transport.describe': return { capabilities: capability ? ['harness.remote.stream.transfer.v1'] : [] }
      case 'harness.remote.stream.open': return host.openStream(params)
      case 'harness.remote.stream.close': return host.closeStream(params)
      case 'harness.remote.transfer.read': return host.readTransfer(params)
      case 'harness.remote.transfer.close': return host.closeTransfer(params)
      default: throw new Error('Unexpected RPC ' + method)
    }
  })
  const client = {
    rpc,
    onEvent: (listener: (event: EventPayload) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onClose: (listener: () => void) => { closeListeners.add(listener); return () => closeListeners.delete(listener) },
  } as unknown as RemoteClientCore
  return { host, rpc, events, listeners, closeListeners, remote: new RemoteTypertGateway(client) }
}

const large = { type: 'snapshot', text: '历史🔒'.repeat(600_000), cursor: { seq: 317, turn: 'original-turn' } }

describe('negotiated Harness stream transfers', () => {
  it('loads full oversized snapshots in order, including Unicode, live deltas and undefined', async () => {
    const values = [large, { type: 'delta', seq: 318 }, undefined, large]
    const f = fixture(values)
    try {
      const source = await f.remote.open('session/follow', { args: {} }, new AbortController().signal)
      // The first descriptor may arrive before open resolves; it must not exhaust the 4 MiB queue.
      expect(f.events).toHaveLength(1)
      const actual: unknown[] = []
      for await (const value of source) actual.push(value)
      expect(actual).toEqual(values)
      const descriptors = f.events.filter(e => (e.data as HarnessRemoteFrameData).transfer)
      expect(descriptors).toHaveLength(2)
      for (const event of descriptors) {
        const id = (event.data as HarnessRemoteFrameData).transfer!.transferId
        expect(() => f.host.readTransfer({ transferId: id, index: 0 })).toThrow(/not active/)
      }
      expect(f.listeners.size).toBe(0)
    } finally { await f.host.closeAll() }
  })

  it('retains legacy small frames and fails oversized frames without opt-in', async () => {
    const f = fixture([undefined, { old: true }, large], false)
    try {
      const source = await f.remote.open('session/follow', {}, new AbortController().signal)
      const actual: unknown[] = []
      await expect((async () => { for await (const value of source) actual.push(value) })()).rejects.toThrow(/Oversized/)
      expect(actual).toEqual([undefined, { old: true }])
      expect(f.rpc.mock.calls.find(([method]) => method === 'harness.remote.stream.open')?.[1]).not.toHaveProperty('transferFrames')
    } finally { await f.host.closeAll() }
  })

  it.each(['abort-before-consume', 'abort-reading', 'disconnect-reading', 'bad-order', 'early-close', 'idle'] as const)('releases Host transfers and does not emit later items on %s', async scenario => {
    const f = fixture([large, { shouldNotArrive: true }])
    const controller = new AbortController()
    try {
      if (scenario === 'idle') vi.useFakeTimers()
      const source = await f.remote.open('session/follow', {}, controller.signal)
      const descriptor = (f.events[0]!.data as HarnessRemoteFrameData).transfer!
      if (scenario === 'abort-before-consume') controller.abort()
      else if (scenario === 'early-close') f.host.closeTransfer({ transferId: descriptor.transferId })
      else if (scenario === 'idle') {
        await vi.advanceTimersByTimeAsync(TRANSFER_IDLE_MS + 1100)
        vi.useRealTimers()
      } else {
        const original = f.rpc.getMockImplementation()!
        f.rpc.mockImplementation(async (method, params, signal) => {
          if (method === 'harness.remote.transfer.read') {
            if (scenario === 'abort-reading') controller.abort()
            if (scenario === 'disconnect-reading') {
              for (const listener of f.closeListeners) listener()
              await f.host.closeAll()
            }
            if (scenario === 'bad-order') params = { ...params, index: params.index + 1 }
          }
          return original(method, params, signal)
        })
      }
      await expect((async () => { for await (const _ of source) throw new Error('unexpected value') })()).rejects.toBeInstanceOf(Error)
      await vi.waitFor(() => expect(() => f.host.readTransfer({ transferId: descriptor.transferId, index: 0 })).toThrow(/not active/))
      expect(f.events.some(e => (e.data as HarnessRemoteFrameData).value !== undefined)).toBe(false)
    } finally { vi.useRealTimers(); controller.abort(); await f.host.closeAll() }
  })

  it.each(['over-limit', 'wrong-stream', 'malformed-chunk'] as const)('rejects %s without exposing a partial history item', async scenario => {
    const f = fixture([large])
    const controller = new AbortController()
    try {
      const original = f.rpc.getMockImplementation()!
      f.rpc.mockImplementation(async (method, params, signal) => {
        const result = await original(method, params, signal) as any
        if (method === 'harness.remote.transfer.read') {
          if (scenario === 'malformed-chunk') return { ...result, data: '!' }
          if (scenario === 'wrong-stream' && params.index === 0) {
            const bytes = Buffer.from(result.data, 'base64')
            const offset = bytes.indexOf('"streamId":"') + '"streamId":"'.length
            bytes.write('00000000-0000-0000-0000-000000000000', offset, 'ascii')
            return { ...result, data: bytes.toString('base64') }
          }
        }
        return result
      })
      const source = await f.remote.open('session/follow', {}, controller.signal)
      if (scenario === 'over-limit') (f.events[0]!.data as HarnessRemoteFrameData).transfer!.totalBytes = MAX_HARNESS_API_TRANSFER_BYTES + 1
      await expect((async () => { for await (const _ of source) throw new Error('unexpected value') })()).rejects.toThrow(/invalid|Invalid|malformed/)
      if (scenario === 'over-limit') expect(f.rpc.mock.calls.some(([method]) => method === 'harness.remote.transfer.read')).toBe(false)
    } finally { controller.abort(); await f.host.closeAll() }
  })
})
