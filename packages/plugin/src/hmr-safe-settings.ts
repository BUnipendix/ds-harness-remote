/**
 * Serialize settings writes and leave DSH's HMR AsyncLocalStorage context
 * before invoking configEditor. Otherwise a callback reached from a reload is
 * treated as a nested transaction. The pump is kept on globalThis so a hot
 * reload reuses the same queue.
 */

type Job<T> = {
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface Pump {
  enqueue<T>(run: () => Promise<T>): Promise<T>
}

/**
 * The HMR service intentionally keeps its AsyncLocalStorage private.  The
 * runtime still exposes the storage's `exit()` method, which is the boundary
 * configEditor needs when a plugin callback was entered from an HMR reload.
 * Keep this structural so older Hosts without HMR continue to use the pump.
 */
export interface HmrContextLike {
  executing?: {
    exit?<T>(callback: () => T): T
  }
}

const PUMP_KEY = Symbol.for('ds-harness-remote.hmr-safe-settings-pump')

function createPump(): Pump {
  const queue: Job<unknown>[] = []
  let wake!: () => void
  let sleeping = new Promise<void>(resolve => { wake = resolve })

  // Do not await this from plugin activation. Its continuation is deliberately
  // left at module initialization, outside the HMR transaction that may reload
  // the plugin later.
  void (async () => {
    for (;;) {
      if (queue.length === 0) {
        await sleeping
        sleeping = new Promise<void>(resolve => { wake = resolve })
      }
      const job = queue.shift()
      if (job === undefined) continue
      try {
        job.resolve(await job.run())
      } catch (error) {
        job.reject(error)
      }
    }
  })()

  return {
    enqueue<T>(run: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ run, resolve: resolve as (value: unknown) => void, reject })
        wake()
      })
    },
  }
}

const globalState = globalThis as typeof globalThis & { [PUMP_KEY]?: Pump }
const pump = globalState[PUMP_KEY] ?? (globalState[PUMP_KEY] = createPump())

export function runHmrSafe<T>(run: () => Promise<T>, hmr?: HmrContextLike): Promise<T> {
  return pump.enqueue(() => {
    const executing = hmr?.executing
    return typeof executing?.exit === 'function' ? executing.exit(run) : run()
  })
}
