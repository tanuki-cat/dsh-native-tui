import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Maximum bytes one terminal attachment may read into memory. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']
type ImageAttachmentRef = Extract<ContentBlock, { type: 'image' }>['attachment']
type ImageMediaType = ImageAttachmentRef['mediaType']

/** Sniff a clipboard image by its leading bytes. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  const byte = (index: number): number | undefined => data[index]
  if (byte(0) === 0x89 && byte(1) === 0x50 && byte(2) === 0x4e && byte(3) === 0x47
    && byte(4) === 0x0d && byte(5) === 0x0a && byte(6) === 0x1a && byte(7) === 0x0a) return 'image/png'
  if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) return 'image/jpeg'
  if (byte(0) === 0x47 && byte(1) === 0x49 && byte(2) === 0x46 && byte(3) === 0x38) return 'image/gif'
  if (byte(0) === 0x52 && byte(1) === 0x49 && byte(2) === 0x46 && byte(3) === 0x46
    && byte(8) === 0x57 && byte(9) === 0x45 && byte(10) === 0x42 && byte(11) === 0x50) return 'image/webp'
  return undefined
}

/** Preferred filename extension for a supported clipboard image type. */
export function imageExtension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

/** Host attachment capability used by the terminal composer. */
export interface AttachmentsService {
  saveFile(input: { readonly data: Uint8Array; readonly name?: string }): Promise<FileAttachmentRef>
  saveImages(inputs: readonly {
    readonly data: Uint8Array
    readonly mediaType: ImageMediaType
    readonly name?: string
  }[]): Promise<readonly ImageAttachmentRef[]>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
  readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/** One staged prompt attachment. */
export interface PendingAttachment {
  readonly label: string
  readonly kind: 'file' | 'image'
  readonly block: ContentBlock
}

const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Read one local file and commit it through the Host attachment service.
 * @param target - absolute path or path relative to cwd.
 * @param cwd - Session workspace root.
 * @param attachments - Host attachment service.
 * @param maxBytes - maximum bytes accepted for a terminal attachment.
 * @returns the content block and display label.
 */
export async function loadAttachment(
  target: string,
  cwd: string,
  attachments: AttachmentsService,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<PendingAttachment> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('attachment maxBytes must be a positive safe integer')
  const path = resolve(cwd, target)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size > maxBytes) {
    throw new Error('file is ' + String(info.size) + ' bytes; terminal attachment limit is ' + String(maxBytes))
  }
  const data = await readFile(path)
  const name = basename(path)
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()]
  if (mediaType !== undefined) {
    const refs = await attachments.saveImages([{ data, mediaType, name }])
    const ref = refs[0]
    if (ref === undefined) throw new Error('attachment service returned no image reference')
    return {
      label: name,
      kind: 'image',
      block: { type: 'image', attachment: ref },
    }
  }
  const ref = await attachments.saveFile({ data, name })
  return {
    label: name,
    kind: 'file',
    block: { type: 'file', attachment: ref },
  }
}