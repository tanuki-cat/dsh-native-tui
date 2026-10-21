/**
 * pi-tui rendering of one reduced transcript block.
 *
 * The reducer in `transcript.ts` decides which rows exist and in which order;
 * this module turns one of those rows into components. Keeping it separate
 * leaves the reducer readable and lets a row's markup change without touching
 * the event folding rules.
 *
 * @module dsh-native-tui/ui/transcript-render
 */

import { Box, Container, Text, type Component } from '@earendil-works/pi-tui'
import { AssistantMessage } from './assistant-message.js'
import { BarText } from './bar-text.js'
import { renderWriteCard } from './write-card.js'
import { diffLines } from './diff.js'
import { clip, compactCodeExecutionPreview, formatToolArguments } from './tool-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'

/** Tools whose cards follow the code-execution density setting. */
const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['run_code', 'bash', 'pwsh'])

/**
 * Whether a tool name renders as a code-execution card, whose density follows
 * `runCodeDisplay` rather than the generic tool card.
 * @param name - tool name from the durable `tool/call`.
 * @returns true for `run_code`, `bash` and `pwsh`.
 */
export function isCodeExecutionTool(name: string): boolean {
  return CODE_EXECUTION_TOOLS.has(name)
}

function fileToolPath(name: string, args: string): string | undefined {
  if (name !== 'write' && name !== 'edit') return undefined
  try {
    const value: unknown = JSON.parse(args)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as { file_path?: unknown; path?: unknown }
    const path = record.file_path ?? record.path
    return typeof path === 'string' && path.trim() !== '' ? path : undefined
  }
  catch { return undefined }
}

/**
 * Build the component tree for one reduced block.
 * @param block - one reduced transcript row.
 * @param options - palette, Markdown theme and display densities.
 * @returns the component that renders that row.
 */
export function renderTranscriptBlock(block: TranscriptBlock, options: TranscriptOptions): Component {
  const palette = options.palette
  const band = (component: Component, background: (text: string) => string): Component => {
    const box = new Box(1, 0, background)
    box.addChild(component)
    return box
  }
  switch (block.kind) {
    case 'user': {
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('▌ You')), 0, 0))
      container.addChild(new Text(block.text, 0, 0))
      return band(container, palette.userBand)
    }
    case 'assistant': return new AssistantMessage(block, options)
    case 'context': {
      const container = new Container()
      container.addChild(new Text(palette.dim('◇ context · ' + block.label), 0, 0))
      container.addChild(new BarText(clip(block.text), '│ ', palette.dim, palette.dim))
      return container
    }
    case 'tool': {
      if (block.name === 'write') return band(renderWriteCard(block, palette, options.writeExpanded), palette.toolBand)
      // The head line must stay identical for the block's whole life: a change
      // above the main-screen viewport makes pi-tui clear the screen and the
      // scrollback to repaint the transcript. The run state is reported by the
      // status row appended last, which main-screen can patch or extend safely.
      const status = '└ ' + (block.pending ? palette.warning('running…') : block.isError === true ? palette.error('error') : palette.success('done'))
      const diffs = block.diffs ?? []
      const filePath = fileToolPath(block.name, block.args)
      // The header names the tool call that produced the change, then the file.
      const diffHead = (path: string): string => palette.bold(palette.accent('⚙ ' + block.name + ' · ' + path))
      if (diffs.length > 0 || filePath !== undefined) {
        const lines: string[] = []
        if (diffs.length === 0 && filePath !== undefined) lines.push(diffHead(filePath))
        for (const diff of diffs) {
          // Keep native single-file headers stable from call through settlement.
          const path = diffs.length === 1 ? filePath ?? diff.path : diff.path
          lines.push(diffHead(path))
          for (const row of diffLines(diff.oldText, diff.newText, 60)) {
            lines.push(row.kind === 'add'
              ? palette.success('│ + ' + row.text)
              : row.kind === 'remove' ? palette.error('│ - ' + row.text) : palette.dim('│   ' + row.text))
          }
        }
        if (block.pending || block.isError === true || diffs.length === 0) {
          if (block.result?.trim()) lines.push(block.isError === true ? palette.error(clip(block.result)) : clip(block.result))
          lines.push(status)
        }
        return band(new Text(lines.join('\n'), 0, 0), palette.toolBand)
      }
      const compact = isCodeExecutionTool(block.name) && (options.runCodeDisplay ?? 'detailed') === 'compact'
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)), 0, 0))
      if (compact) {
        const preview = compactCodeExecutionPreview(block)
        container.addChild(new Text((preview === '' ? '' : palette.dim('├ ' + preview) + '\n') + status, 0, 0))
        return container
      }
      if (block.args.trim() !== '') {
        container.addChild(new Text(palette.dim('├ args'), 0, 0))
        container.addChild(new BarText(formatToolArguments(block.args), '│ ', palette.dim, palette.dim))
      }
      if (block.result !== undefined && block.result.trim() !== '') {
        container.addChild(new Text(palette.dim('├ result'), 0, 0))
        container.addChild(new BarText(
          clip(block.result),
          '│ ',
          block.isError === true ? palette.error : line => line,
          block.isError === true ? palette.error : palette.dim,
        ))
      }
      container.addChild(new Text(status, 0, 0))
      return band(container, palette.toolBand)
    }
    case 'compaction': {
      // The head line stays fixed like the tool card head: the compaction
      // state lands on the tail row, which main-screen can patch safely while
      // the card is still inside the viewport or after it scrolled away.
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('◆ compaction')), 0, 0))
      const meta = [
        block.shadowedItems === undefined ? undefined : String(block.shadowedItems) + ' item(s)',
        block.shadowedTokens === undefined ? undefined : '~' + String(block.shadowedTokens) + ' tokens',
      ].filter((value): value is string => value !== undefined)
      if (meta.length > 0) container.addChild(new Text(palette.dim(meta.join(' · ')), 0, 0))
      if (block.summary !== undefined && block.summary.trim() !== '') {
        // Keep the card shorter than a typical viewport: main-screen can only
        // patch visible rows, so a card that grows past the viewport after its
        // head scrolled away forces a full repaint of the transcript.
        container.addChild(new BarText(clip(block.summary, 240), '│ ', palette.dim, palette.dim))
      }
      if (block.state === 'interrupted') {
        container.addChild(new Text(palette.warning(clip('Stopped before it committed; the session reopened after it.', 600)), 0, 0))
      }
      if (block.error !== undefined) container.addChild(new Text(palette.error(clip(block.error, 600)), 0, 0))
      // State is the last row: a compaction that finishes after its card scrolled
      // away still only touches the card's tail, never a row above the viewport.
      const state = block.state === 'error'
        ? palette.error('✕ failed')
        : block.state === 'interrupted'
          ? palette.warning('⚠ interrupted')
          : block.state === 'running' ? palette.accent('⟳ compacting…') : palette.success('✓ done')
      container.addChild(new Text(state, 0, 0))
      return container
    }
    case 'waiting': {
      return new Text(palette.accent('⟳ ') + palette.dim(block.text), 0, 0)
    }
    case 'notice': {
      const text = block.text.replaceAll('\n', '\n  ')
      if (block.tone === 'error') return new Text(palette.error('✕ ' + text), 0, 0)
      if (block.tone === 'warning') return new Text(palette.warning('! ' + text), 0, 0)
      return new Text(palette.dim('i ') + text, 0, 0)
    }
  }
}
