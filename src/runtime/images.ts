import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { detectImageMediaType, MAX_ATTACHMENT_BYTES } from './attachments.js'

/** One bounded image prepared for a terminal preview. */
export interface ImagePreview {
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly base64: string
  readonly bytes: number
}

/**
 * Read one supported image into base64 for pi-tui's Image component.
 * @param path - absolute or already-resolved file path.
 * @param maxBytes - maximum file size.
 * @returns image metadata and base64 bytes.
 */
export async function readImagePreview(path: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<ImagePreview> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('image maxBytes must be a positive safe integer')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size > maxBytes) throw new Error('image is ' + String(info.size) + ' bytes; terminal image limit is ' + String(maxBytes))
  const data = await readFile(path)
  const mediaType = detectImageMediaType(data)
  if (mediaType === undefined) throw new Error('unsupported image format; expected PNG, JPEG, GIF, or WebP')
  return {
    path,
    name: basename(path),
    mediaType,
    base64: data.toString('base64'),
    bytes: data.byteLength,
  }
}
