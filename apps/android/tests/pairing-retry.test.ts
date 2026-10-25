import { describe, expect, it, vi } from 'vitest'
import { retryUntilConfirmed } from '../src/services/pairing-retry'

/**
 * The retry loop is the only thing standing between "the operator confirmed on
 * the Host" and "the phone noticed". These cases pin the two properties that
 * matter: it never gives up while the code is valid, and it never keeps trying
 * after the code expired.
 */

const pauseMs = 2_000

describe('pairing retry loop', () => {
  it('stops at the first successful attempt', async () => {
    const attempt = vi.fn(async () => true)
    const sleep = vi.fn(async () => undefined)
    const outcome = await retryUntilConfirmed({ attempt, deadline: 10_000, pauseMs, now: () => 0, sleep })
    expect(outcome).toBe('confirmed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('keeps retrying until the Host confirms', async () => {
    // The first two attempts fail because the operator has not confirmed yet.
    const results = [false, false, true]
    const attempt = vi.fn(async () => results.shift() ?? false)
    const sleep = vi.fn(async () => undefined)
    let clock = 0
    const outcome = await retryUntilConfirmed({
      attempt, deadline: 10_000, pauseMs, sleep,
      now: () => { clock += 1_000; return clock },
    })
    expect(outcome).toBe('confirmed')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives up once the code expired instead of waiting forever', async () => {
    const attempt = vi.fn(async () => false)
    const sleep = vi.fn(async () => undefined)
    let clock = 0
    const outcome = await retryUntilConfirmed({
      attempt, deadline: 5_000, pauseMs, sleep,
      now: () => { clock += 2_000; return clock },
    })
    expect(outcome).toBe('expired')
    // Attempts run while the code is still valid; the last gap would overrun it.
    expect(sleep.mock.calls.length).toBeLessThan(4)
  })

  it('does not attempt at all when the code is already expired', async () => {
    const attempt = vi.fn(async () => false)
    const sleep = vi.fn(async () => undefined)
    const outcome = await retryUntilConfirmed({
      attempt, deadline: 1_000, pauseMs, sleep, now: () => 5_000,
    })
    expect(outcome).toBe('expired')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
