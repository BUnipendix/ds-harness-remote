import type { ChatImage } from '../types'
import { imagePreviewMetadata } from './image-preview-metadata'
import { MAX_PREVIEW_BYTES } from './workspace-file-preview'

export type ChatImageLoader = (image: ChatImage, signal: AbortSignal) => Promise<string>

/** All Host reads stay on the captured authenticated connection. No URL fetching or disk cache. */
export function createChatImageLoader(sources: {
  sessionId: string
  assertCurrent: () => void
  attachment: (sessionId: string, attachmentId: string, signal: AbortSignal) => Promise<unknown>
  workspace: (path: string, signal: AbortSignal) => Promise<{ data: string; mimeType: string }>
}): ChatImageLoader {
  return async (image, signal) => {
    const active = () => {
      if (signal.aborted) throw Object.assign(new Error('Image loading cancelled'), { code: 'RPC_ABORTED' })
      sources.assertCurrent()
    }
    active()
    let uri: string
    if (image.uri?.startsWith('data:')) {
      uri = validatedImageDataUri(image.uri)
    } else if (image.attachmentId !== undefined) {
      const result = await sources.attachment(image.sessionId ?? sources.sessionId, image.attachmentId, signal)
      active()
      if (!record(result) || !record(result.attachment)
        || result.attachment.attachmentId !== image.attachmentId
        || typeof result.attachment.mediaType !== 'string' || typeof result.data !== 'string') throw invalidImage()
      uri = validatedImageDataUri(`data:${result.attachment.mediaType};base64,${result.data}`)
    } else {
      const path = chatImageWorkspacePath(image.uri ?? '')
      if (path === undefined) throw invalidImage()
      const result = await sources.workspace(path, signal)
      active()
      uri = validatedImageDataUri(`data:${result.mimeType};base64,${result.data}`)
    }
    active()
    return uri
  }
}

/** Only Host paths; reject network/protocol-relative URLs, encoded schemes and NUL. */
export function chatImageWorkspacePath(value: string): string | undefined {
  try {
    let path = value.trim()
    if (path.startsWith('file://')) {
      const url = new URL(path)
      if (url.hostname !== '') return undefined
      path = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//u.test(path)) path = path.slice(1)
    } else path = decodeURIComponent(path.split(/[?#]/u, 1)[0] ?? '')
    if (path.length === 0 || path.length > 4096 || /[\u0000-\u001f]/u.test(path)
      || /^[\\/]{2}/u.test(path)
      || (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[A-Za-z]:[\\/]/u.test(path))) return undefined
    return path
  } catch { return undefined }
}

/** Bound compressed bytes and decoded pixels before passing untrusted data to the native decoder. */
export function validatedImageDataUri(uri: string): string {
  if (uri.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 64) throw invalidImage()
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(uri)
  if (!match || match[2]!.length % 4 !== 0) throw invalidImage()
  let binary: string
  try { binary = atob(match[2]!) } catch { throw invalidImage() }
  if (binary.length > MAX_PREVIEW_BYTES || btoa(binary) !== match[2]) throw invalidImage()
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const metadata = imagePreviewMetadata(bytes)
  if (!metadata.ok || metadata.mimeType !== match[1]) throw invalidImage()
  return uri
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function invalidImage(): Error {
  return Object.assign(new Error('Image unavailable or outside preview limits'), { code: 'INVALID_IMAGE' })
}
