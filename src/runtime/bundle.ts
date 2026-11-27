import { createRequire } from 'node:module'
import { realpath, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { strToU8, zipSync } from 'fflate'
import { debug } from '../debug.js'
import { presentedEvents, readContainedDeliverable } from './deliverables.js'

/** Maximum attachment bytes included in one terminal ZIP bundle. */
export const MAX_BUNDLE_ATTACHMENT_BYTES = 64 * 1024 * 1024
/** Maximum bytes copied for one presented deliverable. */
export const MAX_BUNDLE_DELIVERABLE_BYTES = 16 * 1024 * 1024
/**
 * Maximum bytes all presented deliverables may add to one bundle.
 *
 * The per-file cap bounds one deliverable but not their sum, so a session that
 * presented many large files used to grow the archive without limit — and the
 * compressor holds every payload in memory until the archive is written.
 */
export const MAX_BUNDLE_DELIVERABLE_TOTAL_BYTES = 32 * 1024 * 1024

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

/**
 * Claim one archive entry name, suffixing duplicates instead of overwriting.
 *
 * Two attachments can reduce to the same sanitized entry (a shared basename or
 * ids that differ only in removed characters); an archive map would keep just
 * the last payload while the manifest still listed both.
 * @param used - entry names already claimed by this archive.
 * @param base - preferred entry name.
 * @returns a name no earlier entry uses.
 */
function claimEntry(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const slash = base.lastIndexOf('/')
  const dot = base.lastIndexOf('.')
  const stem = dot > slash ? base.slice(0, dot) : base
  const extension = dot > slash ? base.slice(dot) : ''
  for (let index = 2; ; index += 1) {
    const candidate = stem + '-' + String(index) + extension
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

function collectRefs(events: readonly SessionEvent[]): {
  images: ImageRefLike[]
  files: FileRefLike[]
} {
  const images = new Map<string, ImageRefLike>()
  const files = new Map<string, FileRefLike>()
  for (const event of events) {
    const content = event.type === 'assistant/message' || event.type === 'tool/result'
      || event.type === 'system/message' || event.type === 'developer/message'
      ? event.data.message.content
      : event.type === 'user/message' ? event.data.content
        : (event.data as { readonly content?: unknown } | undefined)?.content
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
    if (total + chunk.byteLength > maxBytes) throw new Error('bundle attachment exceeds the size limit')
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/** Entry point the compression worker loads; resolved once per process. */
const FFLATE_ENTRY = createRequire(import.meta.url).resolve('fflate')

/**
 * Worker entry that compresses the whole archive in one background thread.
 *
 * fflate's asynchronous `zip` starts a worker per entry of 160 KB or more, so a
 * bundle with many attachments spawned one thread and one buffer copy each. One
 * dedicated worker keeps the event loop free without that fan-out.
 */
const COMPRESSION_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { zipSync } = require(workerData.fflate)
const files = {}
for (const [name, bytes] of workerData.files) files[name] = bytes
const out = zipSync(files, { level: 6 })
parentPort.postMessage(out, [out.buffer])
`

/**
 * Compress the bundle off the event loop.
 *
 * The terminal's frame loop and the model-stream reader share one event loop, so
 * a synchronous deflate of tens of megabytes freezes both for the length of the
 * archive. Compression therefore runs in one worker, and a runtime that cannot
 * start one falls back to the synchronous path on the intact caller buffers.
 * @param files - archive entries by path.
 * @param signal - cancels compression and terminates the worker.
 * @returns the finished ZIP archive.
 */
async function compressBundle(files: Record<string, Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  try {
    return await new Promise<Uint8Array>((resolveArchive, rejectArchive) => {
      const worker = new Worker(COMPRESSION_WORKER, {
        eval: true,
        workerData: { fflate: FFLATE_ENTRY, files: Object.entries(files) },
      })
      let settled = false
      const onAbort = (): void => {
        const reason = signal?.reason
        settle(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')))
      }
      /** Stop the worker once, and report its outcome only once. */
      const settle = (error: Error | undefined, archive?: Uint8Array): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        void worker.terminate()
        if (error === undefined) resolveArchive(archive as Uint8Array)
        else rejectArchive(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      worker.once('message', (archive: Uint8Array) => { settle(undefined, archive) })
      worker.once('error', error => { settle(error) })
      // An exit without a message means the archive never arrived; the buffers
      // are still intact because the worker received copies.
      worker.once('exit', code => { settle(new Error('bundle compression worker exited with code ' + String(code))) })
    })
  }
  catch (error) {
    if (signal?.aborted) throw error
    // A runtime that cannot start the worker still has to produce a bundle; the
    // opt-in debug trace is where a failing worker becomes visible.
    debug('bundle compression fell back to the main thread: '
      + (error instanceof Error ? error.message : String(error)))
    return zipSync(files, { level: 6 })
  }
}

/**
 * Write a portable ZIP bundle of the Session log, referenced attachments, and presented deliverables.
 * @param agent - active Agent whose durable log is exported.
 * @param target - relative path resolved from cwd, or an absolute path.
 * @param cwd - current workspace used for resolving the output path.
 * @param attachments - Host attachment reads.
 * @param signal - cancels attachment/deliverable reads.
 * @param originalCwd - workspace fallback when the Session header has no directory.
 * @returns written path and included/skipped counts.
 */
export async function exportSessionBundle(
  agent: Agent,
  target: string,
  cwd: string,
  attachments: BundleAttachmentsService,
  signal?: AbortSignal,
  originalCwd = cwd,
): Promise<BundleExportResult> {
  const path = resolve(cwd, target)
  signal?.throwIfAborted()
  const session = agent.session
  const events = session.snapshotEvents()
  const files: Record<string, Uint8Array> = {}
  const entries = new Set<string>(['session.jsonl', 'manifest.json', 'README.txt'])
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

  const refs = collectRefs(events)
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
      const entry = claimEntry(entries, 'attachments/' + safeName(image.attachmentId, 'image') + '-' + name)
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
      const entry = claimEntry(entries, 'attachments/' + safeName(file.attachmentId, 'file') + '-' + name)
      files[entry] = data
      attachmentBytes += data.byteLength
      attachmentRecords.push({ kind: 'file', attachmentId: file.attachmentId, name, entry, bytes: data.byteLength })
    } catch (error) {
      skipped.push('file ' + file.attachmentId + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  let deliverableIndex = 0
  /** Bytes every included deliverable has added; the per-file cap does not bound this. */
  let deliverableBytes = 0
  const workspaces = new Map<string, string>()
  for (const event of presentedEvents(events, session.header.cwd ?? originalCwd)) {
    const root = resolve(event.cwd)
    let workspace = workspaces.get(root)
    if (workspace === undefined) {
      workspace = await realpath(root).catch(() => root)
      workspaces.set(root, workspace)
    }
    for (const { path: itemPath } of event.files) {
      signal?.throwIfAborted()
      try {
        const remaining = MAX_BUNDLE_DELIVERABLE_TOTAL_BYTES - deliverableBytes
        const cap = Math.min(MAX_BUNDLE_DELIVERABLE_BYTES, remaining)
        if (cap <= 0) {
          skipped.push('deliverable ' + itemPath + ': bundle deliverable limit reached')
          continue
        }
        const { absolute, data } = await readContainedDeliverable(root, itemPath, cap, workspace)
        deliverableBytes += data.byteLength
        deliverableIndex += 1
        const entry = claimEntry(entries, 'deliverables/' + String(deliverableIndex) + '-' + safeName(basename(absolute), 'deliverable'))
        files[entry] = data
        deliverableRecords.push({ path: itemPath, entry, bytes: data.byteLength })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('limit is ')) {
          const reason = message.includes('limit is ' + String(MAX_BUNDLE_DELIVERABLE_BYTES))
            ? 'size limit reached' : 'bundle deliverable limit reached'
          skipped.push('deliverable ' + itemPath + ': ' + reason)
        } else {
          skipped.push('deliverable ' + itemPath + ': ' + message)
        }
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
  const archive = await compressBundle(files, signal)
  signal?.throwIfAborted()
  // The archive carries credentials-adjacent session data; keep it private.
  await writeFile(path, archive, { flag: 'wx', mode: 0o600 })
  return {
    path,
    eventCount: events.length,
    attachments: attachmentRecords,
    deliverables: deliverableRecords,
    skipped,
    bytes: archive.byteLength,
  }
}
