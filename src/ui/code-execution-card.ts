import { Container, Text, type Component } from '@earendil-works/pi-tui'
import { ToolBody, toolHeading } from './transcript-chrome.js'
import { SourcePreview } from './source-preview.js'
import { compactCodeExecutionPreview, compactErrorPreview, formatToolArguments } from './tool-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import { literalToolText, toolLabel, ToolOutput } from './tool-output.js'
import { compactToolLabel } from './tool-label.js'

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

/** PTC uses the same compact heading and nested output as native tools. */
export function renderCodeExecutionCard(block: Extract<TranscriptBlock, { kind: 'tool' }>, options: TranscriptOptions): Component {
  const { palette } = options
  const { description, source, meta } = codeExecutionParts(block.args)
  const label = description ?? firstLine(source)
  const container = new Container()
  container.addChild(toolHeading(palette.bold('Ran ') + palette.accent(block.name)
    + (label === undefined ? '' : palette.dim(' · ' + inlineSummary(label))), palette, block))
  const body = new Container()
  container.addChild(new ToolBody(body, palette))
  if (meta.length > 0) body.addChild(new Text(palette.dim(meta.join(' · ')), 0, 0))
  const compact = options.runCodeDisplay === 'compact' && !options.toolsExpanded
  if (compact) {
    const calls = block.callLines ?? []
    const shown = new Set(calls)
    if (calls.length > 0) {
      for (const line of calls) body.addChild(new Text(palette.dim(literalToolText(compactToolLabel(line))), 0, 0))
      if (block.callLinesOmitted) body.addChild(new Text(palette.dim('+ ' + block.callLinesOmitted + ' more calls'), 0, 0))
    } else {
      const preview = compactCodeExecutionPreview(block)
      if (preview !== '' && preview !== label) {
        body.addChild(new Text(palette.dim(literalToolText(preview)), 0, 0))
        shown.add(preview)
      }
    }
    if (block.isError || block.stopped) {
      const message = compactErrorPreview(block.result)
      if (message !== '' && !shown.has(message)) body.addChild(new Text(palette.error(literalToolText(message)), 0, 0))
    }
    body.addChild(new Text(palette.dim('(ctrl+o to expand)'), 0, 0))
  } else {
    if (source !== undefined) {
      const lines = literalToolText(source).split('\n')
      while (lines.at(-1) === '') lines.pop()
      const preview: string[] = []
      let used = 0, shortened = false
      const budget = options.toolsExpanded ? 65536 : CODE_PREVIEW_CHARS
      for (const line of lines) {
        if (preview.length >= (options.toolsExpanded ? 2000 : CODE_PREVIEW_LINES) || used >= budget) break
        const remaining = options.toolsExpanded ? budget - used : Math.min(CODE_LINE_CHARS, budget - used)
        const text = line.length > remaining ? line.slice(0, Math.max(0, remaining - 1)) + '…' : line
        if (text.length !== line.length) shortened = true
        preview.push(text)
        used += text.length + 1
      }
      if (preview.length > 0) body.addChild(new SourcePreview(preview.join('\n'), CODE_EXECUTION_LANGUAGES[block.name], palette))
      const hidden = lines.length - preview.length
      if (hidden > 0 || shortened) body.addChild(new Text(palette.dim(
        '+ ' + hidden + ' more lines' + (shortened ? ' · long lines shortened' : '')
          + (options.toolsExpanded ? ' · preview limit' : ' · ctrl+o to expand'),
      ), 0, 0))
    } else if (block.args.trim() !== '') {
      body.addChild(new ToolOutput(formatToolArguments(block.args), palette, options.toolsExpanded ?? false))
    }
    if (block.result?.trim()) body.addChild(new ToolOutput(block.result, palette, options.toolsExpanded ?? false,
      RESULT_PREVIEW_LINES, 'end', block.isError))
  }
  if (block.pending) container.addChild(new Text(palette.warning('  └ running…'), 0, 0))
  else if (block.isError) container.addChild(new Text(palette.error('  └ error'), 0, 0))
  else if (block.stopped) container.addChild(new Text(palette.warning('  └ stopped · inspect the partial result'), 0, 0))
  return container
}
