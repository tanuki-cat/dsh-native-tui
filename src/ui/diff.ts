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
