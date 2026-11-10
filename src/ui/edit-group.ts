import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import { isAbsolute, relative } from 'node:path'
import type { FileDiff } from './diff.js'
import { renderEditDiff, type DiffStats } from './edit-card.js'
import { isWriteUpdate } from './tool-label.js'
import { toolHeading } from './transcript-chrome.js'
import { toolLabel } from './tool-output.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
export interface EditGroupBlock {
  readonly kind: 'edits'
  readonly tools: readonly ToolBlock[]
}
export type DisplayBlock = TranscriptBlock | EditGroupBlock

/** Only Host-confirmed successful modifications participate in an edited-files summary. */
export function isAppliedEdit(block: TranscriptBlock): block is ToolBlock {
  return block.kind === 'tool' && !block.pending && !block.isError && !block.stopped
    && (block.name === 'edit' || block.name === 'apply_patch' || isWriteUpdate(block))
    && (block.diffs?.length ?? 0) > 0
}

/** Group adjacent modifications after notices have been placed; durable events stay unchanged. */
export function groupEdits(blocks: readonly TranscriptBlock[]): DisplayBlock[] {
  const result: DisplayBlock[] = []
  let current: { readonly kind: 'edits'; readonly tools: ToolBlock[] } | undefined
  for (const block of blocks) {
    if (!isAppliedEdit(block)) { current = undefined; result.push(block); continue }
    if (current !== undefined && block.turn !== undefined && current.tools[0]?.turn === block.turn) current.tools.push(block)
    else { current = { kind: 'edits', tools: [block] }; result.push(current) }
  }
  return result
}

interface FilePreview {
  readonly path: string
  readonly previews: Array<Component & { readonly stats: DiffStats }>
  stats: DiffStats
}

const addStats = (left: DiffStats, right: DiffStats): DiffStats => ({
  added: left.added + right.added, removed: left.removed + right.removed,
  approximate: left.approximate || right.approximate,
})
const zeroStats = (): DiffStats => ({ added: 0, removed: 0, approximate: false })

/** One bounded file list retains each applied hunk and its cumulative operation counts. */
export class EditGroupCard implements Component {
  private expanded: boolean
  private files: readonly FilePreview[] | undefined
  private previews = new WeakMap<FileDiff, Component & { readonly stats: DiffStats }>()
  private height = 0

  constructor(private tools: readonly ToolBlock[], private readonly options: TranscriptOptions) {
    this.expanded = options.toolsExpanded ?? false
  }

  get isExpanded(): boolean { return this.expanded }
  update(tools: readonly ToolBlock[]): void { this.tools = tools; this.files = undefined }
  setExpanded(expanded: boolean): void { this.expanded = expanded; this.invalidate() }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.shift || event.alt || event.ctrl
      || (event.y !== 0 && event.y !== this.height - 1)) return undefined
    this.setExpanded(!this.expanded)
    return { handled: true }
  }

  private prepare(): readonly FilePreview[] {
    if (this.files !== undefined) return this.files
    const files = new Map<string, FilePreview>()
    for (const tool of this.tools) {
      for (const diff of tool.diffs ?? []) {
        let preview = this.previews.get(diff)
        if (preview === undefined) {
          preview = renderEditDiff(diff, this.options.palette, this.expanded, { maxRows: this.expanded ? 2000 : 4, summary: false, changedOnly: !this.expanded })
          this.previews.set(diff, preview)
        }
        const file = files.get(diff.path) ?? { path: diff.path, previews: [], stats: zeroStats() }
        file.previews.push(preview)
        file.stats = addStats(file.stats, preview.stats)
        files.set(diff.path, file)
      }
    }
    this.files = [...files.values()]
    return this.files
  }

  private counts(stats: DiffStats): string {
    const palette = this.options.palette, estimate = stats.approximate ? '~' : ''
    return '(' + palette.success(estimate + '+' + stats.added) + ' ' + palette.error(estimate + '-' + stats.removed) + ')'
  }

  render(width: number): string[] {
    const { palette } = this.options
    const files = this.prepare()
    const stats = files.reduce((sum, file) => addStats(sum, file.stats), zeroStats())
    const lines = toolHeading(palette.bold('Edited ' + files.length + (files.length === 1 ? ' file ' : ' files ')) + this.counts(stats),
      palette, { pending: false }).render(width)
    const maxFiles = this.expanded ? 64 : 8
    const inset = Math.min(2, Math.max(0, width - 1)), innerWidth = Math.max(1, width - inset)
    for (const [index, file] of files.slice(0, maxFiles).entries()) {
      if (index > 0) lines.push('')
      const counts = this.counts(file.stats)
      const prefix = width >= 4 ? '  └ ' : ''
      const pathWidth = Math.max(0, width - visibleWidth(prefix + counts) - 1)
      const label = this.options.cwd !== undefined && isAbsolute(file.path) ? relative(this.options.cwd, file.path) || file.path : file.path
      const path = toolLabel(label, 160, 'end'), pathCells = visibleWidth(path)
      const shown = pathCells <= pathWidth ? path : (pathWidth > 0 ? '…' + sliceByColumn(path, pathCells - pathWidth + 1, Math.max(0, pathWidth - 1)) : '')
      lines.push(truncateToWidth(palette.dim(prefix) + shown + ' ' + counts, width, '…'))
      let used = 0, omitted = false
      const budget = this.expanded ? Math.max(0, 2000 - lines.length) : 4
      for (const preview of file.previews) {
        if (used >= budget) { omitted = true; break }
        const rows = preview.render(innerWidth)
        const available = Math.max(0, budget - used)
        lines.push(...rows.slice(0, available).map(row => ' '.repeat(inset) + row))
        used += Math.min(available, rows.length)
        omitted ||= rows.length > available
      }
      if (omitted) lines.push(truncateToWidth(palette.dim('  ⋮ ' + (this.expanded ? 'preview limit' : 'more diff lines')), width, '…'))
      if (this.expanded && lines.length >= 2000) {
        lines.push(truncateToWidth(palette.dim('… [preview limit; /diff inspects individual calls]'), width, '…'))
        break
      }
    }
    if (files.length > maxFiles) lines.push(truncateToWidth(palette.dim('  … ' + (files.length - maxFiles) + ' more files' + (this.expanded ? ' · preview limit' : '')), width, '…'))
    lines.push(truncateToWidth(palette.dim(this.expanded ? '  - Hide details · ctrl+o to collapse' : '  + Show details · ctrl+o to expand'), width, '…'))
    this.height = lines.length
    return palette.plain ? lines.map(stripTerminalSequences) : lines
  }

  invalidate(): void { this.files = undefined; this.previews = new WeakMap() }
}
