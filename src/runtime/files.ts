import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { sanitizeTerminalText } from './terminal-text.js'
export { sanitizeTerminalText } from './terminal-text.js'

/** One directory entry shown by the terminal file browser. */
export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/**
 * List one directory without following symlinked directories.
 * @param path - absolute or already-resolved directory path.
 * @param maxEntries - maximum rows retained.
 * @returns directories first, then files, each group case-insensitively sorted.
 */
export async function listDirectory(path: string, maxEntries = 500): Promise<DirectoryEntry[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('directory maxEntries must be a positive safe integer')
  const entries = await readdir(path, { withFileTypes: true })
  const rows: DirectoryEntry[] = entries.map(entry => ({
    name: entry.name,
    path: join(path, entry.name),
    kind: entry.isDirectory() ? 'directory' : 'file',
  }))
  rows.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
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
 * Read a bounded UTF-8 preview of one regular file.
 * @param path - absolute or already-resolved file path.
 * @param maxBytes - maximum bytes decoded into the preview.
 * @returns preview text and truncation facts.
 */
export async function readTextPreview(path: string, maxBytes = 16_384): Promise<TextPreview> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('preview maxBytes must be a positive safe integer')
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