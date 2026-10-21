/** One file's applied before/after text from tool/result metadata. */
export interface FileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

/** One display row of a terminal diff. */
export interface DiffLine {
  readonly kind: 'add' | 'remove' | 'context'
  readonly text: string
}

function isFileDiff(value: unknown): value is FileDiff {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { path?: unknown; oldText?: unknown; newText?: unknown }
  return typeof candidate.path === 'string'
    && (candidate.oldText === null || typeof candidate.oldText === 'string')
    && typeof candidate.newText === 'string'
}

/**
 * Narrow opaque tool/result metadata to the file-diff envelope used by write/edit.
 * @param meta - persisted or live result metadata.
 * @returns non-empty valid diffs, or undefined.
 */
export function asFileDiffs(meta: unknown): FileDiff[] | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const diffs = (meta as { readonly diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/**
 * Synthetic create diff, remembered per result metadata and call arguments.
 *
 * The reducer runs on every stream frame and a block is only reused while its
 * value is identical, so building a fresh array for an unchanged create would
 * rebuild that card on every frame. A WeakMap keyed by the metadata keeps the
 * array stable for as long as the result does and lets it be collected with the
 * event it belongs to. The arguments are part of the entry because the written
 * content comes from them: the same metadata paired with rewritten arguments
 * must not serve the previous content.
 */
const createDiffs = new WeakMap<object, { readonly args: string; readonly diff: FileDiff[] }>()

/**
 * Read a result's diffs, falling back to the call arguments for a created
 * file. The Host records an empty diff list for creates (there is no prior
 * content to compare) and exposes the written content in the arguments.
 * @param meta - persisted or live result metadata.
 * @param args - raw JSON arguments of the matching call.
 * @returns non-empty file diffs, or undefined when there is nothing to show.
 */
export function resultFileDiffs(meta: unknown, args: string): FileDiff[] | undefined {
  const diffs = asFileDiffs(meta)
  if (diffs !== undefined) return diffs
  if (meta === null || typeof meta !== 'object') return undefined
  const record = meta as { readonly operation?: unknown; readonly path?: unknown }
  if (record.operation !== 'create') return undefined
  const cached = createDiffs.get(record)
  if (cached !== undefined && cached.args === args) return cached.diff
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  }
  catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const call = parsed as { readonly file_path?: unknown; readonly content?: unknown }
  const path = typeof call.file_path === 'string'
    ? call.file_path
    : typeof record.path === 'string' ? record.path : undefined
  const content = typeof call.content === 'string' ? call.content : undefined
  if (path === undefined || content === undefined) return undefined
  const created: FileDiff[] = [{ path, oldText: null, newText: content }]
  createDiffs.set(record, { args, diff: created })
  return created
}

/**
 * Compute a bounded line diff with a longest-common-subsequence walk.
 * Text larger than the safety cap falls back to whole-file remove/add rows.
 * @param oldText - previous text, or null for a created file.
 * @param newText - resulting text.
 * @param maxLines - maximum emitted rows.
 * @returns ordered diff rows, oldest first.
 */
export function diffLines(oldText: string | null, newText: string, maxLines = 120): DiffLine[] {
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0) throw new Error('diff maxLines must be a positive safe integer')
  const before = oldText === null ? [] : oldText.split('\n')
  const after = newText.split('\n')
  const rows: DiffLine[] = []
  if (oldText === null) {
    for (const line of after) rows.push({ kind: 'add', text: line })
    return cap(rows, maxLines)
  }
  if (before.length * after.length > 40_000 || before.length > 400 || after.length > 400) {
    for (const line of before) rows.push({ kind: 'remove', text: line })
    for (const line of after) rows.push({ kind: 'add', text: line })
    return cap(rows, maxLines)
  }
  const width = after.length + 1
  const table = new Uint16Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0)
    }
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i]! })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      rows.push({ kind: 'remove', text: before[i]! })
      i += 1
    } else {
      rows.push({ kind: 'add', text: after[j]! })
      j += 1
    }
    if (rows.length > maxLines * 2) break
  }
  while (i < before.length) {
    rows.push({ kind: 'remove', text: before[i]! })
    i += 1
  }
  while (j < after.length) {
    rows.push({ kind: 'add', text: after[j]! })
    j += 1
  }
  return cap(rows, maxLines)
}

function cap(rows: DiffLine[], maxLines: number): DiffLine[] {
  if (rows.length <= maxLines) return rows
  return [
    ...rows.slice(0, maxLines - 1),
    { kind: 'context', text: '… ' + String(rows.length - (maxLines - 1)) + ' lines omitted' },
  ]
}
