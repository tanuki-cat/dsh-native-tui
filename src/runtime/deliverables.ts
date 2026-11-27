import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { readBoundedFileNoFollow } from './files.js'

function outsideWorkspace(root: string, path: string): boolean {
  const local = relative(root, path)
  return local === '..' || local.startsWith('..' + '/') || local.startsWith('..' + '\\') || isAbsolute(local)
}

/**
 * Resolve one model-declared deliverable inside the workspace it belonged to,
 * rejecting both lexical traversal and symlinks escaping that workspace.
 */
export async function resolveContainedDeliverable(
  root: string,
  itemPath: string,
  workspaceReal?: string,
): Promise<{ readonly absolute: string; readonly real: string }> {
  const base = resolve(root)
  const absolute = resolve(base, itemPath)
  if (outsideWorkspace(base, absolute)) throw new Error('outside the session workspace')
  const workspace = workspaceReal ?? await realpath(base).catch(() => base)
  const real = await realpath(absolute)
  if (outsideWorkspace(workspace, real)) throw new Error('outside the session workspace')
  return { absolute, real }
}

/** One bounded deliverable read through the containment check that admitted it. */
export interface ContainedDeliverable {
  readonly absolute: string
  readonly real: string
  readonly data: Buffer
}

/**
 * Resolve and read one deliverable without a TOCTOU gap between the containment
 * check and the read.
 *
 * The parent directory is resolved once and must stay inside the workspace; the
 * final component is then opened with `O_NOFOLLOW`, so a symlink swapped in
 * after the check cannot redirect the read and is rejected instead. The bytes
 * come from that same descriptor, bounded by `maxBytes`.
 * @param root - workspace root the Host declared the deliverable in.
 * @param itemPath - the model-declared path.
 * @param maxBytes - maximum bytes read.
 * @param workspaceReal - pre-resolved workspace root, when the caller has it.
 * @param label - file kind used in bound errors.
 * @param limitName - bound name used in over-size errors.
 * @returns the lexical absolute path, the opened path, and its bytes.
 */
export async function readContainedDeliverable(
  root: string,
  itemPath: string,
  maxBytes: number,
  workspaceReal?: string,
  label = 'deliverable',
  limitName = 'limit',
): Promise<ContainedDeliverable> {
  const base = resolve(root)
  const absolute = resolve(base, itemPath)
  if (outsideWorkspace(base, absolute)) throw new Error('outside the session workspace')
  const workspace = workspaceReal ?? await realpath(base).catch(() => base)
  // Resolve the parent directory rather than the target: `O_NOFOLLOW` below
  // rejects a final-component symlink, including one that points back inside.
  const parent = await realpath(dirname(absolute))
  if (absolute !== base && outsideWorkspace(workspace, parent)) throw new Error('outside the session workspace')
  const real = join(parent, basename(absolute))
  const data = await readBoundedFileNoFollow(real, maxBytes, label, limitName)
  return { absolute, real, data }
}

/** One file declared by the present tool. */
export interface PresentedFileView {
  readonly path: string
  readonly description?: string
}

/** One deliverables/presented session event projection. */
export interface PresentedEventView {
  readonly turn: number
  readonly files: readonly PresentedFileView[]
  readonly cwd?: string
}

/** One de-duplicated presented file with its latest declaring turn. */
export interface CollectedDeliverable {
  readonly path: string
  readonly description?: string
  readonly turn: number
  readonly cwd?: string
}

/** Attribute each declaration to the workspace the Host had committed at that event. */
export function presentedEvents(events: readonly SessionEvent[], originalCwd: string): (PresentedEventView & { cwd: string })[] {
  let cwd = originalCwd
  const presented: (PresentedEventView & { cwd: string })[] = []
  for (const event of events) {
    if ((event.type as string) === 'workspace-root/change') {
      const moved = (event.data as { readonly cwd?: unknown }).cwd
      if (typeof moved === 'string' && isAbsolute(moved)) cwd = moved
    } else if ((event.type as string) === 'deliverables/presented') {
      const data = event.data as { readonly turn: number; readonly files?: unknown }
      if (!Array.isArray(data.files)) continue
      const files = data.files.filter((file): file is PresentedFileView =>
        file !== null && typeof file === 'object' && typeof file.path === 'string')
      presented.push({ cwd, turn: data.turn, files })
    }
  }
  return presented
}

/**
 * Collect presented files, keeping the latest declaration for each path.
 * @param events - presented events in session order.
 * @returns unique files in first-declaration order.
 */
export function collectDeliverables(events: readonly PresentedEventView[]): CollectedDeliverable[] {
  const byPath = new Map<string, CollectedDeliverable>()
  for (const event of events) {
    for (const file of event.files) {
      const key = event.cwd === undefined ? file.path : resolve(event.cwd, file.path)
      byPath.set(key, {
        path: file.path,
        ...(file.description === undefined ? {} : { description: file.description }),
        turn: event.turn,
        ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
      })
    }
  }
  return [...byPath.values()]
}

/**
 * Format durable presented files, de-duplicated by path with the latest declaration winning.
 * @param events - presented events in session order.
 * @param maxFiles - maximum rows shown.
 * @returns compact multi-line list.
 */
export function formatDeliverables(events: readonly PresentedEventView[], maxFiles = 50): string {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error('deliverables maxFiles must be a positive safe integer')
  const rows = collectDeliverables(events)
  if (rows.length === 0) return 'No presented deliverables.'
  const lines = ['Deliverables · ' + String(rows.length) + ' file(s)']
  for (const [index, row] of rows.slice(0, maxFiles).entries()) {
    lines.push(String(index) + '. ' + row.path
      + (row.description === undefined || row.description === '' ? '' : ' — ' + row.description)
      + '  (turn ' + String(row.turn) + ')')
  }
  if (rows.length > maxFiles) lines.push('… ' + String(rows.length - maxFiles) + ' more file(s)')
  return lines.join('\n')
}
