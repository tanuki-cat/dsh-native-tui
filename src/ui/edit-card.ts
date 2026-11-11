import { Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { diffLines, diffSourceLines, MAX_DIFF_INPUT_LINES, MAX_DIFF_MATRIX_CELLS, type DiffLine, type FileDiff } from './diff.js'
import type { Palette } from './theme.js'
import { literalToolText } from './tool-output.js'
import { diffRow } from './transcript-chrome.js'

interface NumberedRow {
  readonly kind: DiffLine['kind'] | 'omitted'
  readonly text: string
  readonly line?: number
}

export interface DiffStats {
  readonly added: number
  readonly removed: number
  readonly approximate: boolean
}

/** Applied diffs use Host metadata only; rendering never reopens the file. */
export function renderEditDiff(diff: FileDiff, palette: Palette, expanded = false,
  options: { readonly maxRows?: number; readonly summary?: boolean; readonly changedOnly?: boolean } = {}): Component & { readonly stats: DiffStats } {
  const before = diff.oldText === null ? [] : diffSourceLines(diff.oldText)
  const after = diffSourceLines(diff.newText)
  let commonPrefix = 0, commonSuffix = 0
  while (commonPrefix < before.length && commonPrefix < after.length && before[commonPrefix] === after[commonPrefix]) commonPrefix += 1
  while (commonSuffix < before.length - commonPrefix && commonSuffix < after.length - commonPrefix
    && before[before.length - 1 - commonSuffix] === after[after.length - 1 - commonSuffix]) commonSuffix += 1
  const contextLines = 3
  const start = Math.max(0, commonPrefix - contextLines)
  const beforeEnd = before.length - Math.max(0, commonSuffix - contextLines)
  const afterEnd = after.length - Math.max(0, commonSuffix - contextLines)
  const beforeCount = beforeEnd - start, afterCount = afterEnd - start
  const limit = options.maxRows ?? (expanded ? 2000 : 24)
  const omittedHint = expanded ? ' · preview limit' : ''
  let rows: NumberedRow[] = []
  let added = 0, removed = 0, approximate = false
  if (beforeCount > MAX_DIFF_INPUT_LINES || afterCount > MAX_DIFF_INPUT_LINES || beforeCount * afterCount > MAX_DIFF_MATRIX_CELLS) {
    // The fallback samples both sides directly instead of allocating a whole-file diff.
    const contextBefore = commonPrefix - start
    const contextAfter = Math.min(commonSuffix, contextLines)
    removed = before.length - commonPrefix - commonSuffix
    added = after.length - commonPrefix - commonSuffix
    approximate = true
    const budget = Math.max(0, limit - (options.changedOnly ? 0 : contextBefore + contextAfter) - 2)
    const removeBudget = Math.min(removed, budget - Math.min(added, Math.floor(budget / 2)))
    const addBudget = Math.min(added, budget - removeBudget)
    for (let index = start; index < commonPrefix; index += 1) rows.push({ kind: 'context', text: before[index]!, line: index + 1 })
    for (let index = 0; index < removeBudget; index += 1) rows.push({ kind: 'remove', text: before[commonPrefix + index]!, line: commonPrefix + index + 1 })
    if (removed > removeBudget) rows.push({ kind: 'omitted', text: '… ' + (removed - removeBudget) + ' removed lines omitted' + omittedHint })
    for (let index = 0; index < addBudget; index += 1) rows.push({ kind: 'add', text: after[commonPrefix + index]!, line: commonPrefix + index + 1 })
    if (added > addBudget) rows.push({ kind: 'omitted', text: '… ' + (added - addBudget) + ' added lines omitted' + omittedHint })
    for (let index = 0; index < contextAfter; index += 1) {
      const line = after.length - commonSuffix + index
      rows.push({ kind: 'context', text: after[line]!, line: line + 1 })
    }
  } else {
    // The calculation can emit at most two rows per input line. Display limits apply afterwards.
    const source = (lines: readonly string[]): string => lines.length === 0 ? '' : lines.join('\n') + '\n'
    const calculated = diffLines(diff.oldText === null ? null : source(before.slice(start, beforeEnd)),
      source(after.slice(start, afterEnd)), MAX_DIFF_INPUT_LINES * 2)
    added = calculated.filter(row => row.kind === 'add').length
    removed = calculated.filter(row => row.kind === 'remove').length
    let oldLine = start + 1, newLine = start + 1
    rows = calculated.map(row => {
      const line = row.kind === 'remove' ? oldLine : newLine
      if (row.kind !== 'add') oldLine += 1
      if (row.kind !== 'remove') newLine += 1
      return { ...row, line }
    })
    if (options.changedOnly) rows = rows.filter(row => row.kind !== 'context')
    if (rows.length > limit) {
      const head = Math.floor((limit - 1) / 2)
      const tail = limit - head - 1
      rows = [...rows.slice(0, head), { kind: 'omitted', text: '… ' + (rows.length - head - tail) + ' diff lines omitted' + omittedHint }, ...rows.slice(-tail)]
    }
  }
  if (options.changedOnly) rows = rows.filter(row => row.kind !== 'context')
  const gutter = String(Math.max(before.length, after.length)).length
  const estimate = approximate ? '~' : ''
  const summary = '(' + estimate + '+' + added + ' ' + estimate + '-' + removed + ')'
    + (added === 0 && removed === 0 && diff.oldText !== null && diff.oldText !== diff.newText ? ' · line endings changed' : '')
  const lines: Array<{ text: string; kind: NumberedRow['kind'] }> = options.summary === false ? [] : [{ text: palette.dim(summary), kind: 'context' }]
  if (options.summary === false && added === 0 && removed === 0 && diff.oldText !== null && diff.oldText !== diff.newText) {
    lines.push({ text: palette.dim('line endings changed'), kind: 'omitted' })
  }
  let characterBudget = 65536
  let limited = false
  if (start > 0 && !options.changedOnly) lines.push({ text: palette.dim('… ' + start + ' unchanged lines'), kind: 'omitted' })
  for (const row of rows) {
    if (row.kind === 'omitted') { lines.push({ text: palette.dim(row.text), kind: row.kind }); continue }
    const rowPrefix = String(row.line).padStart(gutter) + ' ' + (row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ') + ' '
    const color = row.kind === 'add' ? palette.success : row.kind === 'remove' ? palette.error : palette.dim
    const source = rowPrefix + literalToolText(row.text.slice(0, 65536))
    const bounded = source.slice(0, characterBudget)
    if (bounded.length < source.length || row.text.length > 65536) limited = true
    lines.push({ text: color(bounded), kind: row.kind })
    characterBudget -= bounded.length
    if (characterBudget <= 0) { limited = true; break }
  }
  if (commonSuffix > contextLines && !options.changedOnly) lines.push({ text: palette.dim('… ' + (commonSuffix - contextLines) + ' unchanged lines'), kind: 'omitted' })
  if (limited) lines.push({ text: palette.dim('… [diff content omitted by preview limit]'), kind: 'omitted' })
  return {
    stats: { added, removed, approximate },
    render: width => {
      const clipped = lines.flatMap(line => {
        const rendered = expanded ? new Text(line.text, 0, 0).render(width) : [truncateToWidth(line.text, Math.max(0, width))]
        const band = line.kind === 'add' ? palette.diffAddBand : line.kind === 'remove' ? palette.diffRemoveBand : (text: string) => text
        return rendered.map(text => diffRow(text, width, band))
      })
      if (!expanded && lines.some(line => visibleWidth(line.text) > width)) {
        clipped.push(truncateToWidth(palette.dim('… (long diff lines clipped)'), Math.max(0, width)))
      }
      return clipped
    },
    invalidate: () => {},
  }
}
