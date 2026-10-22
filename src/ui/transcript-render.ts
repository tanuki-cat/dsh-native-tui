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
import { highlightCode } from './code-preview.js'
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

/** Code lines a detailed code-execution card shows before truncating. */
const CODE_PREVIEW_LINES = 12

/** highlight.js language per code-execution tool. */
const CODE_EXECUTION_LANGUAGES: Readonly<Record<string, string>> = {
  run_code: 'typescript',
  bash: 'bash',
  pwsh: 'powershell',
}

/**
 * Collapse a one-line head suffix and keep terminal control characters out of
 * the card head, which main-screen cannot repaint once it scrolled away.
 * @param text - model-provided label text.
 * @returns a bounded single-line label.
 */
function inlineSummary(text: string): string {
  const escaped = text.replace(/\s+/gu, ' ').trim()
    .replace(/[\x00-\x1f\x7f]/g, character => '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0'))
  return escaped.length <= 60 ? escaped : escaped.slice(0, 59) + '…'
}

/** Description, source and extra call options extracted from tool arguments. */
interface CodeExecutionParts {
  readonly description?: string
  readonly source?: string
  readonly meta: readonly string[]
}

/** Human duration for the timeoutMs argument. */
function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? String(ms / 1000) + 's' : String(ms) + 'ms'
}

/** First non-empty line of a command or program, used when no description is given. */
function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/**
 * Read the fields a code-execution card renders: the description names the call,
 * the source (code for run_code, command for shells) is the body, and the meta
 * line keeps call options that change what the command means.
 * @param args - raw JSON arguments from the durable tool call.
 * @returns the recognized fields; empty when the payload is not an object.
 */
function codeExecutionParts(args: string): CodeExecutionParts {
  try {
    const value: unknown = JSON.parse(args)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { meta: [] }
    const record = value as {
      readonly code?: unknown
      readonly command?: unknown
      readonly description?: unknown
      readonly timeoutMs?: unknown
      readonly workdir?: unknown
      readonly run_in_background?: unknown
      readonly sandbox_permissions?: unknown
    }
    const source = typeof record.code === 'string' ? record.code
      : typeof record.command === 'string' ? record.command : undefined
    const description = typeof record.description === 'string' && record.description.trim() !== ''
      ? record.description : undefined
    const meta: string[] = []
    if (typeof record.workdir === 'string' && record.workdir.trim() !== '') {
      meta.push('workdir ' + inlineSummary(record.workdir))
    }
    if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0) {
      meta.push('timeout ' + formatTimeout(record.timeoutMs))
    }
    if (record.run_in_background === true) meta.push('background')
    if (typeof record.sandbox_permissions === 'string' && record.sandbox_permissions !== '') {
      meta.push('sandbox ' + record.sandbox_permissions)
    }
    return {
      ...(description === undefined ? {} : { description }),
      ...(source === undefined ? {} : { source }),
      meta,
    }
  }
  catch { return { meta: [] } }
}

/**
 * Detailed card for run_code, bash and pwsh.
 *
 * Mirrors the write/diff cards: the head names the call (the description, or the
 * source's first line when there is none), call options that change what the
 * command means stay on a dim meta row, the body is highlighted source instead of
 * a JSON argument dump, and the result keeps the labeled gutter.
 * @param block - one pending or settled tool row.
 * @param options - palette and display densities.
 * @param status - tail row shared with the generic tool card.
 * @returns the card component.
 */
function renderCodeExecutionCard(
  block: Extract<TranscriptBlock, { kind: 'tool' }>,
  options: TranscriptOptions,
  status: string,
): Component {
  const palette = options.palette
  const { description, source, meta } = codeExecutionParts(block.args)
  const container = new Container()
  const label = description ?? firstLine(source)
  const head = '⚙ ' + block.name + (label === undefined ? '' : ' · ' + inlineSummary(label))
  container.addChild(new Text(palette.bold(palette.accent(head)), 0, 0))
  if (meta.length > 0) container.addChild(new Text(palette.dim('  ' + meta.join(' · ')), 0, 0))
  if (source !== undefined) {
    const lines = source.replace(/\r\n?/g, '\n').replaceAll('\t', '  ').split('\n')
    while (lines.at(-1) === '') lines.pop()
    if (lines.length > 0) {
      container.addChild(new BarText(
        highlightCode(lines.slice(0, CODE_PREVIEW_LINES).join('\n'), CODE_EXECUTION_LANGUAGES[block.name], palette),
        '│ ',
        text => text,
        palette.dim,
      ))
      if (lines.length > CODE_PREVIEW_LINES) {
        container.addChild(new Text(palette.dim(
          '… (' + String(lines.length - CODE_PREVIEW_LINES) + ' more lines, ' + String(lines.length) + ' total)',
        ), 0, 0))
      }
    }
  }
  if (block.result !== undefined && block.result.trim() !== '') {
    container.addChild(new Text(palette.dim('├ result'), 0, 0))
    container.addChild(new BarText(
      clip(block.result),
      '│ ',
      block.isError === true ? palette.error : text => text,
      block.isError === true ? palette.error : palette.dim,
    ))
  }
  else if (source === undefined && block.args.trim() !== '') {
    // An unrecognized payload keeps the generic dump rather than an empty card.
    container.addChild(new Text(palette.dim('├ args'), 0, 0))
    container.addChild(new BarText(formatToolArguments(block.args), '│ ', palette.dim, palette.dim))
  }
  container.addChild(new Text(status, 0, 0))
  const box = new Box(1, 0, palette.toolBand)
  box.addChild(container)
  return box
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
      if (isCodeExecutionTool(block.name) && (options.runCodeDisplay ?? 'detailed') === 'compact') {
        const container = new Container()
        container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)), 0, 0))
        const preview = compactCodeExecutionPreview(block)
        container.addChild(new Text((preview === '' ? '' : palette.dim('├ ' + preview) + '\n') + status, 0, 0))
        return container
      }
      if (isCodeExecutionTool(block.name)) return renderCodeExecutionCard(block, options, status)
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)), 0, 0))
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
