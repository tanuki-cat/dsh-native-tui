import { Container, Markdown, Spacer, Text, type MarkdownTheme } from '@earendil-works/pi-tui'
import { Rule } from './rule.js'
import { BarText } from './bar-text.js'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'

/** One process-local live assistant chunk entry. */
export interface LiveChunkEntry {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: string
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

/** Durable Session event or one transient live assistant chunk. */
export type TranscriptEntry =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'live'; readonly event: LiveChunkEntry }
import type { Palette } from './theme.js'
import { asFileDiffs, diffLines, type FileDiff } from './diff.js'

/** Maximum characters retained in one tool preview. */
const TOOL_PREVIEW = 1200
/** Maximum characters retained in one reasoning preview. */
const REASONING_PREVIEW = 3000

/** One rendered transcript row. */
export type TranscriptBlock = ({
  readonly kind: 'user'; readonly text: string
} | {
  readonly kind: 'assistant'; readonly text: string; readonly reasoning?: string; readonly live: boolean
} | {
  readonly kind: 'context'; readonly label: string; readonly text: string
} | {
  readonly kind: 'tool'
  readonly callId: string
  readonly name: string
  readonly args: string
  readonly result?: string
  readonly isError?: boolean
  readonly pending: boolean
  readonly diffs?: readonly FileDiff[]
} | {
  readonly kind: 'notice'; readonly tone: 'info' | 'warning' | 'error'; readonly text: string
}) & {
  /** Durable event sequence that produced this block. */
  readonly seq?: number
  /** Local notice placement: show after this durable sequence. */
  readonly afterSeq?: number
}

/** Options controlling transcript reduction. */
export interface TranscriptOptions {
  readonly showReasoning: boolean
  readonly maxEntries: number
  readonly palette: Palette
  readonly markdown: MarkdownTheme
}

/** Read visible assistant/user text from content blocks. */
export function contentText(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal') continue
    else if (block.type === 'image') parts.push('[image ' + (block.attachment.name ?? block.attachment.mediaType) + ']')
    else if (block.type === 'file') parts.push('[file ' + block.attachment.name + ']')
    else parts.push('[content]')
  }
  return parts.join('\n')
}

/** Read reasoning text from content blocks. */
export function contentReasoning(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
}

/** Clip one line-oriented preview without changing its content. */
export function clip(text: string, limit = TOOL_PREVIEW): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [${String(text.length - limit)} chars omitted]`
}

/**
 * Format a model-produced JSON argument string for a readable tool call.
 * Known fields keep their names; long string values such as code are split
 * into indented rows instead of one wrapped JSON line.
 * @param raw - raw JSON arguments from the tool call.
 * @returns a bounded, multi-line display value.
 */
export function formatToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return clip(trimmed, TOOL_PREVIEW)
  }
  if (value === null || typeof value !== 'object') return clip(String(value), TOOL_PREVIEW)
  const rows: Array<readonly [string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>)
  const lines: string[] = []
  for (const [key, item] of rows.slice(0, 12)) {
    if (typeof item === 'string') {
      const text = clip(item, 900)
      if (text.includes('\n')) {
        lines.push(key + ':')
        for (const line of text.split('\n')) lines.push('  ' + line)
      } else {
        lines.push(key + ': ' + text)
      }
    } else {
      lines.push(key + ': ' + clip(JSON.stringify(item) ?? String(item), 500))
    }
  }
  if (rows.length > 12) lines.push('… ' + String(rows.length - 12) + ' more fields')
  return clip(lines.join('\n'), 2400)
}

function toolResultText(message: { readonly content?: readonly ContentBlock[] }): string {
  return contentText(message.content)
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/**
 * Fold the Client event window into terminal rows. The reducer is intentionally
 * independent from pi-tui so it can be unit-tested without a terminal.
 * @param entries - contiguous durable and transient event window.
 * @param options - display limits and palette.
 * @returns rendered transcript blocks, oldest first.
 */
export function reduceTranscript(
  entries: readonly TranscriptEntry[],
  options: TranscriptOptions,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  const liveByStep = new Map<string, { index: number; text: string; reasoning: string }>()
  const finalizedSteps = new Set<string>()
  const toolByCall = new Map<string, number>()

  const pushLive = (event: LiveChunkEntry): void => {
    const key = stepKey(event.data.turn, event.data.step)
    if (finalizedSteps.has(key)) return
    let live = liveByStep.get(key)
    if (live === undefined) {
      const index = blocks.length
      blocks.push({ kind: 'assistant', text: '', reasoning: '', live: true })
      live = { index, text: '', reasoning: '' }
      liveByStep.set(key, live)
    }
    const chunk: StreamChunk = event.data.chunk
    if (chunk.type === 'text-delta') live.text += chunk.text
    else if (chunk.type === 'reasoning-delta' && options.showReasoning) live.reasoning += chunk.text
    blocks[live.index] = {
      kind: 'assistant',
      text: live.text,
      ...(live.reasoning === '' ? {} : { reasoning: live.reasoning }),
      live: true,
    }
  }

  for (const entry of entries) {
    if (entry.type === 'live') {
      pushLive(entry.event)
      continue
    }
    const event: SessionEvent = entry.event
    const seq = Number(event.seq)
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'user') {
          blocks.push({ kind: 'user', text: contentText(event.data.content), seq })
        } else {
          const text = contentText(event.data.content)
          if (text.trim() !== '') {
            const label = 'plugin' in source && typeof source.plugin === 'string'
              ? source.plugin
              : source.kind
            blocks.push({ kind: 'context', label, text, seq })
          }
        }
        break
      }
      case 'assistant/message': {
        const key = stepKey(event.data.turn, event.data.step)
        finalizedSteps.add(key)
        const live = liveByStep.get(key)
        if (live !== undefined) {
          blocks[live.index] = { kind: 'assistant', text: '', live: true }
        }
        const text = contentText(event.data.message.content)
        const reasoning = options.showReasoning ? contentReasoning(event.data.message.content) : ''
        if (text.trim() !== '' || reasoning.trim() !== '') {
          blocks.push({
            kind: 'assistant',
            text,
            ...(reasoning === '' ? {} : { reasoning }),
            live: false,
            seq,
          })
        }
        break
      }
      case 'assistant/attempt': {
        const key = stepKey(event.data.turn, event.data.step)
        finalizedSteps.add(key)
        const live = liveByStep.get(key)
        if (live !== undefined) blocks[live.index] = { kind: 'assistant', text: '', live: true }
        break
      }
      case 'tool/call': {
        const index = blocks.length
        toolByCall.set(event.data.callId, index)
        blocks.push({
          kind: 'tool',
          callId: event.data.callId,
          name: event.data.name,
          args: event.data.arguments,
          pending: true,
          seq,
        })
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const index = toolByCall.get(callId)
        const result = toolResultText(event.data.message)
        const isError = event.data.message.isError === true
        const diffs = asFileDiffs(event.data.meta)
        if (index === undefined) {
          blocks.push({
            kind: 'tool',
            callId,
            name: 'tool',
            args: '',
            result,
            ...(isError ? { isError: true } : {}),
            ...(diffs === undefined ? {} : { diffs }),
            pending: false,
            seq,
          })
        } else {
          const prior = blocks[index]
          if (prior?.kind === 'tool') {
            blocks[index] = {
              ...prior,
              result,
              ...(isError ? { isError: true } : {}),
              ...(diffs === undefined ? {} : { diffs }),
              pending: false,
              seq,
            }
          }
        }
        break
      }
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'error') {
          blocks.push({
            kind: 'notice',
            tone: 'error',
            text: `Turn failed: ${reason.error.code}: ${reason.error.message}`,
            seq,
          })
        } else if (reason.kind === 'aborted') {
          blocks.push({ kind: 'notice', tone: 'warning', text: 'Turn cancelled', seq })
        } else if (reason.kind === 'max-tokens') {
          blocks.push({ kind: 'notice', tone: 'warning', text: 'Turn stopped at the output-token limit', seq })
        }
        break
      }
      case 'command/done': {
        const result = event.data
        if (result.text !== undefined && result.text !== '') {
          blocks.push({
            kind: 'notice',
            tone: result.kind === 'error' ? 'error' : 'info',
            text: result.text,
            seq,
          })
        }
        break
      }
      default:
        break
    }
  }

  const visible = blocks.filter(block => !(block.kind === 'assistant' && block.text === '' && (block.reasoning ?? '') === ''))
  if (visible.length <= options.maxEntries) return visible
  const hidden = visible.length - options.maxEntries
  return [
    { kind: 'notice', tone: 'info', text: `… ${String(hidden)} earlier transcript entries hidden …` },
    ...visible.slice(-options.maxEntries),
  ]
}

/** Pi-tui renderer for one reduced transcript. */
export class TranscriptRenderer {
  readonly container = new Container()
  private entries: readonly TranscriptEntry[] = []
  private extra: readonly TranscriptBlock[] = []
  private readonly options: TranscriptOptions

  /**
   * @param options - reduction and styling options.
   */
  constructor(options: TranscriptOptions) {
    this.options = options
  }

  /** Replace both the event window and local notices in one rebuild. */
  set(entries: readonly TranscriptEntry[], notices: readonly TranscriptBlock[]): void {
    this.entries = entries
    this.extra = notices
    this.rebuild()
  }

  /** Replace the event window and rebuilt rows. */
  setEntries(entries: readonly TranscriptEntry[]): void {
    this.entries = entries
    this.rebuild()
  }

  /** Add local-only notices after the durable transcript. */
  setNotices(notices: readonly TranscriptBlock[]): void {
    this.extra = notices
    this.rebuild()
  }

  /** Remove every rendered row, including local notices. */
  clear(): void {
    this.entries = []
    this.extra = []
    this.container.clear()
  }

  private rebuild(): void {
    const durable = reduceTranscript(this.entries, this.options)
    const anchored = this.extra.filter((notice): notice is TranscriptBlock & { afterSeq: number } => notice.afterSeq !== undefined)
    const trailing = this.extra.filter(notice => notice.afterSeq === undefined)
    const blocks: TranscriptBlock[] = []
    const pending = [...anchored]
    for (const block of durable) {
      while (pending.length > 0 && pending[0]!.afterSeq < (block.seq ?? Number.POSITIVE_INFINITY)) {
        blocks.push(pending.shift()!)
      }
      blocks.push(block)
    }
    blocks.push(...pending, ...trailing)
    this.container.clear()
    for (const [index, block] of blocks.entries()) {
      if (index > 0) this.container.addChild(new Spacer(1))
      if (index > 0 && block.kind === 'user') {
        this.container.addChild(new Rule(this.options.palette.dim))
        this.container.addChild(new Spacer(1))
      }
      this.container.addChild(this.renderBlock(block))
    }
  }

  private renderBlock(block: TranscriptBlock) {
    const palette = this.options.palette
    switch (block.kind) {
      case 'user': {
        const container = new Container()
        container.addChild(new Text(palette.bold(palette.accent('▌ You')), 0, 0))
        container.addChild(new BarText(block.text, '│ ', line => line, palette.accent))
        return container
      }
      case 'assistant': {
        const container = new Container()
        const label = palette.bold(palette.accent('◆ assistant'))
          + (block.live === true ? '  ' + palette.warning('streaming') : '')
        container.addChild(new Text(label, 0, 0))
        if (block.reasoning !== undefined && block.reasoning.trim() !== '') {
          container.addChild(new Spacer(1))
          container.addChild(new Text(palette.dim('thinking'), 0, 0))
          container.addChild(new BarText(clip(block.reasoning, REASONING_PREVIEW), '│ ', palette.dim, palette.dim))
        }
        if (block.text.trim() !== '') {
          container.addChild(new Spacer(1))
          container.addChild(new Markdown(block.text, 0, 0, this.options.markdown))
        }
        return container
      }
      case 'context': {
        const container = new Container()
        container.addChild(new Text(palette.dim('◇ context · ' + block.label), 0, 0))
        container.addChild(new BarText(clip(block.text), '│ ', palette.dim, palette.dim))
        return container
      }
      case 'tool': {
        const status = block.pending ? palette.warning('running') : block.isError === true ? palette.error('error') : palette.success('done')
        const container = new Container()
        container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)) + '  ' + status, 0, 0))
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
        if (block.diffs !== undefined) {
          const lines = [palette.dim('├ diff')]
          for (const diff of block.diffs) {
            lines.push(palette.bold(palette.accent('│ diff ' + diff.path)))
            for (const row of diffLines(diff.oldText, diff.newText, 60)) {
              lines.push(row.kind === 'add'
                ? palette.success('│ + ' + row.text)
                : row.kind === 'remove' ? palette.error('│ - ' + row.text) : palette.dim('│   ' + row.text))
            }
          }
          container.addChild(new Text(lines.join('\n'), 0, 0))
        }
        return container
      }
      case 'notice': {
        const text = block.text.replaceAll('\n', '\n  ')
        if (block.tone === 'error') return new Text(palette.error('✕ ' + text), 0, 0)
        if (block.tone === 'warning') return new Text(palette.warning('! ' + text), 0, 0)
        return new Text(palette.dim('i ') + text, 0, 0)
      }
    }
  }
}