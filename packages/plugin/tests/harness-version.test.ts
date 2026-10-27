import { describe, expect, it } from 'vitest'
import {
  harnessSessionGeneration,
  normalizeHarnessVersion,
} from '../src/harness-version.js'

describe('Harness version discovery', () => {
  it('rejects malformed reported versions', () => {
    expect(normalizeHarnessVersion('  ')).toBeUndefined()
    expect(normalizeHarnessVersion('0.1.0\ninvalid')).toBeUndefined()
  })

  it('separates the v0.1.5 Session V3 wire from the v0.1.2 profile', () => {
    expect(harnessSessionGeneration('0.1.2-rc.1')).toBe('legacy')
    expect(harnessSessionGeneration('dsh-v0.1.5-alpha.1')).toBe('v3')
    expect(harnessSessionGeneration('0.1.5-rc.1')).toBe('v3')
    expect(harnessSessionGeneration('0.1.7-rc.1')).toBe('v3')
    expect(harnessSessionGeneration('0.2.0-rc.1')).toBe('v3')
    for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-rc.1', 'dsh-v0.2.1-rc.1', '0.2.1', '0.2.2-rc.1']) {
      expect(harnessSessionGeneration(version), version).toBe('v3')
    }
    expect(harnessSessionGeneration('dsh-v0.2.0-rc.1')).toBe('v3')
    expect(harnessSessionGeneration('0.3.0')).toBe('legacy')
    expect(harnessSessionGeneration('1.0.0')).toBe('legacy')
    expect(harnessSessionGeneration(undefined)).toBe('legacy')
  })
})
