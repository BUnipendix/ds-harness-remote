import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { runHmrSafe, type HmrContextLike } from '../src/hmr-safe-settings.js'

describe('runHmrSafe', () => {
  it('runs queued writes outside the caller async context', async () => {
    const storage = new AsyncLocalStorage<string>()
    const value = await storage.run('polluted-by-hmr', () => runHmrSafe(async () => storage.getStore()))
    expect(value).toBeUndefined()
  })

  it('serializes writes and propagates failures', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = runHmrSafe(async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
      return 1
    })
    const second = runHmrSafe(async () => {
      events.push('second')
      return 2
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    release()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['first:start', 'first:end', 'second'])
    await expect(runHmrSafe(async () => { throw new Error('write failed') })).rejects.toThrow('write failed')
  })

  it('exits the host HMR transaction before invoking a settings write', async () => {
    const hmrStorage = new AsyncLocalStorage<boolean>()
    const hmr: HmrContextLike = { executing: hmrStorage }
    const value = await hmrStorage.run(true, () => runHmrSafe(async () => hmrStorage.getStore(), hmr))
    expect(value).toBeUndefined()
  })
})
