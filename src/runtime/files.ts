import { constants } from 'node:fs'
import { open, opendir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { sanitizeTerminalText } from './terminal-text.js'
export { sanitizeTerminalText } from './terminal-text.js'

/** One directory entry shown by the terminal file browser. */
export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** Case-insensitive name order used by the file browser. */
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

function compareNames(left: string, right: string): number {
  return NAME_COLLATOR.compare(left, right)
}

/**
 * Keep one name window sorted, dropping the tail past `limit`.
 *
 * A directory listing is read as a stream, so only the rows that can reach the
 * visible page are retained instead of materializing and sorting every entry.
 */
function insertName(names: string[], name: string, limit: number): void {
  if (names.length === limit && compareNames(name, names[limit - 1]!) >= 0) return
  let low = 0
  let high = names.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareNames(names[middle]!, name) <= 0) low = middle + 1
    else high = middle
  }
  names.splice(low, 0, name)
  if (names.length > limit) names.pop()
}

/**
 * List one directory without following symlinked directories.
 * @param path - absolute or already-resolved directory path.
 * @param maxEntries - maximum rows retained.
 * @returns directories first, then files, each group case-insensitively sorted.
 */
export async function listDirectory(path: string, maxEntries = 500): Promise<DirectoryEntry[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('directory maxEntries must be a positive safe integer')
  // A per-kind window this size always contains the rows that survive the
  // combined cap: at most `maxEntries` come from either group.
  const directories: string[] = []
  const files: string[] = []
  for await (const entry of await opendir(path)) {
    insertName(entry.isDirectory() ? directories : files, entry.name, maxEntries)
  }
  const rows: DirectoryEntry[] = [
    ...directories.map(name => ({ name, path: join(path, name), kind: 'directory' as const })),
    ...files.map(name => ({ name, path: join(path, name), kind: 'file' as const })),
  ]
  return rows.slice(0, maxEntries)
}

/** Whether a path has a Markdown document extension. */
export function isMarkdownPath(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension === '.md' || extension === '.markdown' || extension === '.mdx'
}

/** Bounded terminal-safe text preview of one regular file. */
export interface TextPreview {
  readonly path: string
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

/**
 * Reject special files before their descriptor is opened.
 *
 * `O_NONBLOCK` keeps a POSIX open from waiting for a FIFO writer, but Windows
 * ignores the flag, so a named pipe could block inside `open` itself. The
 * pre-open check narrows that window; the post-open `fstat` still owns the
 * decision because the path can be replaced in between.
 * @param path - file about to be opened.
 */
async function refuseNonRegularBeforeOpen(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (info !== undefined && !info.isFile()) throw new Error('not a regular file')
}

/**
 * Read a bounded UTF-8 preview of one regular file.
 * @param path - absolute or already-resolved file path.
 * @param maxBytes - maximum bytes decoded into the preview.
 * @returns preview text and truncation facts.
 */
export async function readTextPreview(path: string, maxBytes = 16_384): Promise<TextPreview> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('preview maxBytes must be a positive safe integer')
  await refuseNonRegularBeforeOpen(path)
  // Special files must reach fstat without waiting for a FIFO writer.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    const raw = Buffer.alloc(maxBytes)
    let total = 0
    while (total < maxBytes) {
      const { bytesRead } = await file.read(raw, total, maxBytes - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const text = sanitizeTerminalText(new TextDecoder().decode(raw.subarray(0, total)))
    return { path, text, bytes: info.size, truncated: info.size > maxBytes }
  } finally {
    await file.close()
  }
}

/**
 * Read one regular file safely within `maxBytes` without blocking on special files
 * or trusting pre-read `stat` sizes across TOCTOU races.
 */
export async function readBoundedFile(path: string, maxBytes: number, label = 'file', limitName = 'limit'): Promise<Buffer> {
  return readBoundedPath(path, maxBytes, label, limitName, false)
}

/**
 * Read one regular file within `maxBytes` without following a symlink at the
 * final path component. Callers are responsible for checking that the parent
 * directory stays inside its workspace.
 */
export async function readBoundedFileNoFollow(path: string, maxBytes: number, label = 'file', limitName = 'limit'): Promise<Buffer> {
  return readBoundedPath(path, maxBytes, label, limitName, true)
}

async function readBoundedPath(
  path: string,
  maxBytes: number,
  label: string,
  limitName: string,
  noFollow: boolean,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(label + ' maxBytes must be a positive safe integer')
  if (!noFollow) await refuseNonRegularBeforeOpen(path)
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)
  const file = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (noFollow && error.code === 'ELOOP') throw new Error('is a symbolic link')
    throw error
  })
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    if (info.size > maxBytes) {
      throw new Error(label + ' is ' + String(info.size) + ' bytes; ' + limitName + ' is ' + String(maxBytes))
    }
    // Size the working buffer to this file, not to the cap: a `/export zip` of
    // many small deliverables used to pin one `maxBytes + 1` backing store per
    // file. The extra byte stays for the over-read probe, and a file that grew
    // past its stat size extends this buffer up to the same probe bound.
    let raw = Buffer.allocUnsafe(Math.min(info.size + 1, maxBytes + 1))
    let total = 0
    while (total <= maxBytes) {
      if (total >= raw.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(Math.max(raw.byteLength * 2, total + 1), maxBytes + 1))
        raw.copy(grown, 0, 0, total)
        raw = grown
      }
      const { bytesRead } = await file.read(raw, total, raw.byteLength - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) throw new Error(label + ' exceeds ' + limitName + ' of ' + String(maxBytes) + ' bytes')
    if (raw.byteLength === total) return raw
    // A grown or probe buffer may be larger than the payload; copy the exact
    // bytes into an unpooled buffer so the caller does not retain the slack.
    const exact = Buffer.allocUnsafeSlow(total)
    raw.copy(exact, 0, 0, total)
    return exact
  } finally {
    await file.close()
  }
}
