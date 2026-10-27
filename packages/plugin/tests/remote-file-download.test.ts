import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { downloadRemoteFile } from '../src/remote-file-download.js'
import type { RemoteTypertGateway } from '../src/remote-typert-gateway.js'
import { sessionToolInputs } from '../src/remote-session-tools.js'

describe('Remote file download integrity', () => {
  it('writes exact scoped bytes and removes partial downloads on invalid or canceled transfers', async () => {
    await runScenarios(['success', 'empty', 'changed', 'offset', 'oversized', 'cancel', 'authority'].map(kind => ({ name: kind, run: async () => {
      const directory = await mkdtemp(join(tmpdir(), 'remote-download-test-'))
      const controller = new AbortController()
      const bytes = kind === 'empty' ? new Uint8Array() : new Uint8Array([0, 255, 7])
      let calls = 0
      let authorized = true
      const stat = { absolutePath: '/workspace/result.bin', version: 'v1', bytes: bytes.length }
      const gateway = { invoke: async (request: { namespace: string; method: string; args: Record<string, unknown> }) => {
        expect(request.namespace).toBe('workspaceFiles')
        expect(request.args.workspaceFileScopeId).toBe('session')
        expect(request.args.path).toBe('result.bin')
        if (request.method === 'stat') return { ...stat, ...(kind === 'changed' && calls ? { version: 'v2' } : {}), ...(kind === 'oversized' ? { bytes: 51 * 1024 * 1024 } : {}) }
        calls++
        if (kind === 'cancel') controller.abort()
        if (kind === 'authority') authorized = false
        return { ...stat, offset: kind === 'offset' ? 1 : 0, data: bytes, eof: true }
      } } as unknown as RemoteTypertGateway
      try {
        const result = downloadRemoteFile(gateway, 'session', 'result.bin', controller.signal,
          () => { if (!authorized) throw new Error('AUTHORITY_CHANGED') }, directory)
        if (kind === 'success' || kind === 'empty') {
          const downloaded = await result
          expect(new Uint8Array(await readFile(downloaded.localPath))).toEqual(bytes)
          expect(downloaded.bytes).toBe(bytes.length)
        } else {
          await expect(result).rejects.toThrow()
          expect(await readdir(directory)).toEqual([])
        }
      } finally { await rm(directory, { recursive: true, force: true }) }
    } })))
  })

  it('rejects paths outside the requested workspace before connecting', () => {
    for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'dir/../secret', 'bad\0name']) {
      expect(sessionToolInputs.remote_download_file.safeParse({ hostId: 'host', backend: 'harness', workspaceId: 'workspace', sessionId: 'session', path }).success).toBe(false)
    }
  })
})
