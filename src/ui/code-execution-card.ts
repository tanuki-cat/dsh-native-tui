import { Box, Container, Text, type Component } from '@earendil-works/pi-tui'
import { BarText } from './bar-text.js'
import { highlightCode } from './code-preview.js'
import { clip, compactCodeExecutionPreview, compactErrorPreview, formatToolArguments } from './tool-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import { literalToolText, toolLabel } from './tool-output.js'

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

/**
 * Code preview bounds: lines, characters per line, and total characters.
 *
 * The card stays in the retained transcript until maxEntries drops it, and
 * pi-tui re-walks every retained row on each paint. A single long line can wrap
 * into dozens of rows, so the preview is bounded the same way the old argument
 * dump was (it clipped each string at 900 characters).
 */
const CODE_PREVIEW_LINES = 12
const CODE_LINE_CHARS = 160
const CODE_PREVIEW_CHARS = 1600

/** Result lines a detailed code-execution card shows before truncating. */
const RESULT_PREVIEW_LINES = 12

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
  return toolLabel(text, 60)
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
      meta.push('sandbox ' + inlineSummary(record.sandbox_permissions))
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
function detailedCodeExecutionCard(
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
    const lines = literalToolText(source).split('\n')
    while (lines.at(-1) === '') lines.pop()
    const preview: string[] = []
    let used = 0
    let shortened = false
    for (const line of lines) {
      if (preview.length >= (options.toolsExpanded ? 2000 : CODE_PREVIEW_LINES) || used >= (options.toolsExpanded ? 65536 : CODE_PREVIEW_CHARS)) break
      const budget = options.toolsExpanded ? 65536 - used : Math.min(CODE_LINE_CHARS, CODE_PREVIEW_CHARS - used)
      const text = line.length > budget ? line.slice(0, Math.max(0, budget - 1)) + '…' : line
      if (text.length !== line.length) shortened = true
      preview.push(text)
      used += text.length
    }
    if (preview.length > 0) {
      container.addChild(new BarText(
        highlightCode(preview.join('\n'), CODE_EXECUTION_LANGUAGES[block.name], palette),
        '│ ',
        text => text,
        palette.dim,
      ))
      const notes: string[] = []
      const hidden = lines.length - preview.length
      if (hidden > 0) notes.push(String(hidden) + ' more lines, ' + String(lines.length) + ' total')
      if (shortened) notes.push('long lines shortened')
      if (notes.length > 0) {
        container.addChild(new Text(palette.dim('… (' + notes.join('; ') + ')'), 0, 0))
      }
    }
  }
  if (block.result !== undefined && block.result.trim() !== '') {
    const resultLines = literalToolText(block.result).split('\n')
    while (resultLines.at(-1) === '') resultLines.pop()
    const resultLimit = options.toolsExpanded ? 2000 : RESULT_PREVIEW_LINES
    const visibleResult = resultLines.slice(0, resultLimit)
    container.addChild(new Text(palette.dim('├ result'), 0, 0))
    container.addChild(new BarText(
      clip(visibleResult.join('\n'), options.toolsExpanded ? 65536 : 1200),
      '│ ',
      block.isError === true ? palette.error : text => text,
      block.isError === true ? palette.error : palette.dim,
    ))
    if (resultLines.length > resultLimit) {
      container.addChild(new Text(palette.dim(
        '… (' + String(resultLines.length - resultLimit) + ' more lines)',
      ), 0, 0))
    }
  }
  else if (source === undefined && block.args.trim() !== '') {
    // An unrecognized payload keeps the generic dump rather than an empty card.
    container.addChild(new Text(palette.dim('├ args'), 0, 0))
    container.addChild(new BarText(literalToolText(formatToolArguments(block.args)), '│ ', palette.dim, palette.dim))
  }
  container.addChild(new Text(status, 0, 0))
  const box = new Box(1, 0, palette.toolBand)
  box.addChild(container)
  return box
}

/** PTC keeps its dispatched-call summary; expansion opens the program and result. */
export function renderCodeExecutionCard(block: Extract<TranscriptBlock, { kind: 'tool' }>, options: TranscriptOptions): Component {
  const palette = options.palette
  const status = '└ ' + (block.pending ? palette.warning('running…') : block.isError ? palette.error('error') : palette.success('done'))
  if ((options.runCodeDisplay ?? 'detailed') !== 'compact' || options.toolsExpanded) return detailedCodeExecutionCard(block, options, status)
  const container = new Container()
  container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)), 0, 0))
  const calls = block.callLines ?? []
  if (calls.length > 0) {
    for (const line of calls) container.addChild(new Text(palette.dim('├ ' + literalToolText(line)), 0, 0))
    if (block.callLinesOmitted) container.addChild(new Text(palette.dim('├ … ' + block.callLinesOmitted + ' more'), 0, 0))
    if (block.isError) {
      const message = compactErrorPreview(block.result)
      if (message !== '') container.addChild(new Text(palette.error('├ ✕ ' + literalToolText(message)), 0, 0))
    }
  } else {
    const preview = compactCodeExecutionPreview(block)
    if (preview !== '') container.addChild(new Text(palette.dim('├ ' + literalToolText(preview)), 0, 0))
  }
  container.addChild(new Text(status, 0, 0))
  const box = new Box(1, 0, palette.toolBand)
  box.addChild(container)
  return box
}
