import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { strToU8, zipSync } from 'fflate'

/** Maximum attachment bytes included in one terminal ZIP bundle. */
export const MAX_BUNDLE_ATTACHMENT_BYTES = 64 * 1024 * 1024
/** Maximum bytes copied for one presented deliverable. */
export const MAX_BUNDLE_DELIVERABLE_BYTES = 16 * 1024 * 1024

interface ImageRefLike {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
  readonly bytes?: number
}

interface FileRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes?: number
}

/** Attachment reads used by the bundle exporter. */
export interface BundleAttachmentsService {
  readImage(ref: ImageRefLike, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
  readFileStream(ref: FileRefLike, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/** One included attachment record in the manifest. */
export interface BundleAttachmentRecord {
  readonly kind: 'file' | 'image'
  readonly attachmentId: string
  readonly name: string
  readonly entry: string
  readonly bytes: number
}

/** One included deliverable record in the manifest. */
export interface BundleDeliverableRecord {
  readonly path: string
  readonly entry: string
  readonly bytes: number
}

/** Result of one terminal ZIP bundle export. */
export interface BundleExportResult {
  readonly path: string
  readonly eventCount: number
  readonly attachments: readonly BundleAttachmentRecord[]
  readonly deliverables: readonly BundleDeliverableRecord[]
  readonly skipped: readonly string[]
  readonly bytes: number
}

function safeName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/u).at(-1) ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[.]+/u, '').slice(0, 80)
  return cleaned === '' ? fallback : cleaned
}

function imageExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/gif': return '.gif'
    case 'image/webp': return '.webp'
    default: return '.png'
  }
}

function collectRefs(events: readonly { readonly type: string; readonly data?: unknown }[]): {
  images: ImageRefLike[]
  files: FileRefLike[]
} {
  const images = new Map<string, ImageRefLike>()
  const files = new Map<string, FileRefLike>()
  for (const event of events) {
    const content = (event.data as { readonly content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const candidate = block as {
        readonly type?: unknown
        readonly attachment?: { readonly attachmentId?: unknown; readonly mediaType?: unknown; readonly name?: unknown; readonly bytes?: unknown }
      }
      const attachment = candidate.attachment
      if (attachment === undefined || typeof attachment.attachmentId !== 'string') continue
      if (candidate.type === 'image' && typeof attachment.mediaType === 'string') {
        images.set(attachment.attachmentId, {
          attachmentId: attachment.attachmentId,
          mediaType: attachment.mediaType,
          ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
          ...(typeof attachment.bytes === 'number' ? { bytes: attachment.bytes } : {}),
        })
      } else if (candidate.type === 'file' && typeof attachment.name === 'string') {
        files.set(attachment.attachmentId, {
          attachmentId: attachment.attachmentId,
          name: attachment.name,
          ...(typeof attachment.bytes === 'number' ? { bytes: attachment.bytes } : {}),
        })
      }
    }
  }
  return { images: [...images.values()], files: [...files.values()] }
}

async function collectFile(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    const remaining = maxBytes - total
    if (remaining <= 0) throw new Error('bundle attachment exceeds the size limit')
    const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    chunks.push(part)
    total += part.byteLength
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/**
 * Write a portable ZIP bundle of the Session log, referenced attachments, and presented deliverables.
 * @param agent - active Agent whose durable log is exported.
 * @param target - relative path resolved from cwd, or an absolute path.
 * @param cwd - Session workspace root used for relative targets and deliverables.
 * @param attachments - Host attachment reads.
 * @param signal - cancels attachment/deliverable reads.
 * @returns written path and included/skipped counts.
 */
export async function exportSessionBundle(
  agent: Agent,
  target: string,
  cwd: string,
  attachments: BundleAttachmentsService,
  signal?: AbortSignal,
): Promise<BundleExportResult> {
  const path = resolve(cwd, target)
  const session = agent.session
  const events = session.snapshotEvents()
  const files: Record<string, Uint8Array> = {}
  const skipped: string[] = []
  const attachmentRecords: BundleAttachmentRecord[] = []
  const deliverableRecords: BundleDeliverableRecord[] = []
  let attachmentBytes = 0

  const header = {
    kind: 'native-tui-session-bundle',
    version: 1,
    id: session.header.id,
    cwd: session.header.cwd,
    createdAt: session.header.createdAt,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
  }
  files['session.jsonl'] = strToU8([JSON.stringify(header), ...events.map(event => JSON.stringify(event))].join('\n') + '\n')

  const refs = collectRefs(events as readonly { readonly type: string; readonly data?: unknown }[])
  for (const image of refs.images) {
    signal?.throwIfAborted()
    if (image.bytes !== undefined && attachmentBytes + image.bytes > MAX_BUNDLE_ATTACHMENT_BYTES) {
      skipped.push('image ' + image.attachmentId + ': bundle attachment limit reached')
      continue
    }
    try {
      const stored = await attachments.readImage(image, signal)
      if (attachmentBytes + stored.data.byteLength > MAX_BUNDLE_ATTACHMENT_BYTES) {
        skipped.push('image ' + image.attachmentId + ': bundle attachment limit reached')
        continue
      }
      const name = safeName(image.name, image.attachmentId + imageExtension(image.mediaType))
      const entry = 'attachments/' + safeName(image.attachmentId, 'image') + '-' + name
      files[entry] = stored.data
      attachmentBytes += stored.data.byteLength
      attachmentRecords.push({ kind: 'image', attachmentId: image.attachmentId, name, entry, bytes: stored.data.byteLength })
    } catch (error) {
      skipped.push('image ' + image.attachmentId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  for (const file of refs.files) {
    signal?.throwIfAborted()
    if (file.bytes !== undefined && attachmentBytes + file.bytes > MAX_BUNDLE_ATTACHMENT_BYTES) {
      skipped.push('file ' + file.attachmentId + ': bundle attachment limit reached')
      continue
    }
    try {
      const data = await collectFile(attachments.readFileStream(file, signal), MAX_BUNDLE_ATTACHMENT_BYTES - attachmentBytes)
      const name = safeName(file.name, file.attachmentId)
      const entry = 'attachments/' + safeName(file.attachmentId, 'file') + '-' + name
      files[entry] = data
      attachmentBytes += data.byteLength
      attachmentRecords.push({ kind: 'file', attachmentId: file.attachmentId, name, entry, bytes: data.byteLength })
    } catch (error) {
      skipped.push('file ' + file.attachmentId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  let deliverableIndex = 0
  for (const event of events) {
    if ((event.type as string) !== 'deliverables/presented') continue
    const presented = (event.data as { readonly files?: unknown }).files
    if (!Array.isArray(presented)) continue
    for (const item of presented) {
      if (item === null || typeof item !== 'object') continue
      const itemPath = (item as { readonly path?: unknown }).path
      if (typeof itemPath !== 'string') continue
      signal?.throwIfAborted()
      try {
        const absolute = resolve(cwd, itemPath)
        const info = await stat(absolute)
        if (!info.isFile()) {
          skipped.push('deliverable ' + itemPath + ': not a regular file')
          continue
        }
        if (info.size > MAX_BUNDLE_DELIVERABLE_BYTES) {
          skipped.push('deliverable ' + itemPath + ': size limit reached')
          continue
        }
        const data = await readFile(absolute)
        deliverableIndex += 1
        const entry = 'deliverables/' + String(deliverableIndex) + '-' + safeName(basename(absolute), 'deliverable')
        files[entry] = data
        deliverableRecords.push({ path: itemPath, entry, bytes: data.byteLength })
      } catch (error) {
        skipped.push('deliverable ' + itemPath + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  const manifest = {
    kind: 'native-tui-session-bundle-manifest',
    version: 1,
    id: session.header.id,
    cwd: session.header.cwd,
    createdAt: session.header.createdAt,
    exportedAt: header.exportedAt,
    eventCount: events.length,
    attachments: attachmentRecords,
    deliverables: deliverableRecords,
    skipped,
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n')
  files['README.txt'] = strToU8(
    'DeepSeek Harness terminal Session bundle\n'
    + 'session.jsonl: header plus every durable event\n'
    + 'manifest.json: bundle facts, attachments, deliverables, and skipped items\n'
    + 'attachments/: binary attachments cited by the Session\n'
    + 'deliverables/: files declared with the present tool\n',
  )
  const archive = zipSync(files, { level: 6 })
  await writeFile(path, archive, { flag: 'wx' })
  return {
    path,
    eventCount: events.length,
    attachments: attachmentRecords,
    deliverables: deliverableRecords,
    skipped,
    bytes: archive.byteLength,
  }
}
