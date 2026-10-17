/** Read-only formatting for Host workspace-change summaries and file comparisons. */
export interface ChangedFileView {
  readonly display: string
  readonly added: number
  readonly deleted: number
  readonly binary?: true
  readonly oversized?: true
}

/** Subset of the Host summary needed by the terminal card. */
export interface ChangesSummaryView {
  readonly turn: number
  readonly cwd: string
  readonly files: readonly ChangedFileView[]
  readonly total: number
  readonly added: number
  readonly deleted: number
}

/** Subset of one Host file comparison needed by the terminal viewer. */
export type WorkspaceDiffView =
  | {
    readonly kind: 'text'
    readonly display: string
    readonly coarse?: boolean
    readonly hunks: readonly {
      readonly oldStart: number
      readonly oldLines: number
      readonly newStart: number
      readonly newLines: number
      readonly lines: readonly string[]
    }[]
  }
  | { readonly kind: 'binary'; readonly display: string }
  | { readonly kind: 'oversized'; readonly display: string }

/**
 * Format one turn's changed-file summary.
 * @param summary - Host summary.
 * @returns compact multi-line card body.
 */
export function formatChangesSummary(summary: ChangesSummaryView): string {
  const lines = [
    'Changed files · turn ' + String(summary.turn) + ' · +' + String(summary.added)
      + ' -' + String(summary.deleted) + ' · ' + String(summary.total) + ' file(s)',
  ]
  for (const [index, file] of summary.files.entries()) {
    const counts = file.binary === true ? 'binary' : file.oversized === true ? 'oversized' : '+' + String(file.added) + ' -' + String(file.deleted)
    lines.push(String(index) + '. ' + file.display + '  ' + counts)
  }
  if (summary.total > summary.files.length) {
    lines.push('… ' + String(summary.total - summary.files.length) + ' more file(s)')
  }
  return lines.join('\n')
}

/**
 * Format one Host file comparison with bounded hunk bodies.
 * @param diff - Host comparison.
 * @param maxLines - maximum diff body lines.
 * @returns compact multi-line card body.
 */
export function formatWorkspaceDiff(diff: WorkspaceDiffView, maxLines = 160): string {
  if (!Number.isSafeInteger(maxLines) || maxLines <= 0) throw new Error('diff maxLines must be a positive safe integer')
  if (diff.kind !== 'text') return 'diff ' + diff.display + ' · ' + diff.kind
  const lines = ['diff ' + diff.display + (diff.coarse === true ? ' · coarse' : '')]
  for (const hunk of diff.hunks) {
    lines.push('@@ -' + String(hunk.oldStart) + ',' + String(hunk.oldLines)
      + ' +' + String(hunk.newStart) + ',' + String(hunk.newLines) + ' @@')
    for (const line of hunk.lines) lines.push(line)
    if (lines.length >= maxLines) break
  }
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines.push('… diff truncated')
  }
  return lines.join('\n')
}
