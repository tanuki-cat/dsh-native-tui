import { Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { diffLines, MAX_DIFF_INPUT_LINES, MAX_DIFF_MATRIX_CELLS, type DiffLine, type FileDiff } from './diff.js'
import type { Palette } from './theme.js'
import { literalToolText } from './tool-output.js'

interface NumberedRow {
  readonly kind: DiffLine['kind'] | 'omitted'
  readonly text: string
  readonly line?: number
}

/** Applied diffs use Host metadata only; rendering never reopens the file. */
export function renderEditDiff(diff: FileDiff, palette: Palette, expanded = false): Component {
  const before = diff.oldText === null ? [] : diff.oldText.split('\n')
  const after = diff.newText.split('\n')
  let commonPrefix = 0, commonSuffix = 0
  while (commonPrefix < before.length && commonPrefix < after.length && before[commonPrefix] === after[commonPrefix]) commonPrefix += 1
  while (commonSuffix < before.length - commonPrefix && commonSuffix < after.length - commonPrefix
    && before[before.length - 1 - commonSuffix] === after[after.length - 1 - commonSuffix]) commonSuffix += 1
  const start = Math.max(0, commonPrefix - 3)
  const beforeEnd = before.length - Math.max(0, commonSuffix - 3)
  const afterEnd = after.length - Math.max(0, commonSuffix - 3)
  const beforeCount = beforeEnd - start, afterCount = afterEnd - start
  const limit = expanded ? 2000 : 60
  const omittedHint = expanded ? ' · preview limit' : ' · ctrl+o to expand'
  let rows: NumberedRow[] = []
  if (beforeCount > MAX_DIFF_INPUT_LINES || afterCount > MAX_DIFF_INPUT_LINES || beforeCount * afterCount > MAX_DIFF_MATRIX_CELLS) {
    // The fallback samples both sides directly instead of allocating a whole-file diff.
    const contextBefore = commonPrefix - start
    const contextAfter = Math.min(commonSuffix, 3)
    const removed = before.length - commonPrefix - commonSuffix
    const added = after.length - commonPrefix - commonSuffix
    const budget = Math.max(0, limit - contextBefore - contextAfter - 2)
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
    const calculated = diffLines(diff.oldText === null ? null : before.slice(start, beforeEnd).join('\n'),
      after.slice(start, afterEnd).join('\n'), MAX_DIFF_INPUT_LINES * 2)
    let oldLine = start + 1, newLine = start + 1
    rows = calculated.map(row => {
      const line = row.kind === 'remove' ? oldLine : newLine
      if (row.kind !== 'add') oldLine += 1
      if (row.kind !== 'remove') newLine += 1
      return { ...row, line }
    })
    if (rows.length > limit) {
      const head = Math.floor((limit - 1) / 2)
      const tail = limit - head - 1
      rows = [...rows.slice(0, head), { kind: 'omitted', text: '… ' + (rows.length - head - tail) + ' diff lines omitted · ctrl+o to expand' }, ...rows.slice(-tail)]
    }
  }
  const gutter = String(Math.max(before.length, after.length)).length
  const lines: string[] = []
  let characterBudget = 65536
  let limited = false
  if (start > 0) lines.push(palette.dim('  … ' + start + ' unchanged lines'))
  for (const row of rows) {
    if (row.kind === 'omitted') { lines.push(palette.dim(row.text)); continue }
    const rowPrefix = (row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ') + ' ' + String(row.line).padStart(gutter) + ' '
    const color = row.kind === 'add' ? palette.success : row.kind === 'remove' ? palette.error : palette.dim
    const source = rowPrefix + literalToolText(row.text.slice(0, 65536))
    const bounded = source.slice(0, characterBudget)
    if (bounded.length < source.length || row.text.length > 65536) limited = true
    lines.push(color(bounded))
    characterBudget -= bounded.length
    if (characterBudget <= 0) { limited = true; break }
  }
  if (commonSuffix > 3) lines.push(palette.dim('  … ' + (commonSuffix - 3) + ' unchanged lines'))
  if (limited) lines.push(palette.dim('… [diff content omitted by preview limit]'))
  if (expanded) return new Text(lines.join('\n'), 0, 0)
  return {
    render: width => {
      const clipped = lines.map(line => truncateToWidth(line, Math.max(0, width)))
      if (lines.some(line => visibleWidth(line) > width)) {
        clipped.push(truncateToWidth(palette.dim('… (long diff lines clipped · ctrl+o to expand)'), Math.max(0, width)))
      }
      return clipped
    },
    invalidate: () => {},
  }
}
