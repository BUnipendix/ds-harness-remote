/**
 * Wait for a Host confirmation that can arrive at any moment.
 *
 * A pairing tunnel finishes the Noise handshake but stays out of the Host's
 * connection controller until the operator confirms the code. Every attempt
 * therefore fails until that happens, and the Server drops the idle tunnel
 * between attempts. The code itself is derived from the pairing nonce and both
 * static keys, so all attempts inside one offer share the same code: the phone
 * only has to keep trying until the offer expires.
 */
export interface PairingRetryOptions {
  /** One connection attempt. Resolves true once the Host routed traffic. */
  attempt: () => Promise<boolean>
  /** Timestamp after which the pairing code is no longer worth trying. */
  deadline: number
  /** Gap between attempts. */
  pauseMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type PairingRetryOutcome = 'confirmed' | 'expired'

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function retryUntilConfirmed(options: PairingRetryOptions): Promise<PairingRetryOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  for (;;) {
    if (await options.attempt()) return 'confirmed'
    // Stop before sleeping past the deadline so an expired code never costs an
    // extra wait that can no longer succeed.
    if (now() + options.pauseMs >= options.deadline) return 'expired'
    await sleep(options.pauseMs)
  }
}
