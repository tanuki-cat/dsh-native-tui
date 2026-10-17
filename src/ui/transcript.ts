import { Container, Markdown, Spacer, Text, type MarkdownTheme } from '@earendil-works/pi-tui'
import { Rule } from './rule.js'
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
export type TranscriptBlock =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly reasoning?: string; readonly live: boolean }
  | { readonly kind: 'context'; readonly label: string; readonly text: string }
  | {
    readonly kind: 'tool'
    readonly callId: string
    readonly name: string
    readonly args: string
    readonly result?: string
    readonly isError?: boolean
    readonly pending: boolean
    readonly diffs?: readonly FileDiff[]
  }
  | { readonly kind: 'notice'; readonly tone: 'info' | 'warning' | 'error'; readonly text: string }

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
    else if (block.type === 'image') parts.push('[image ' + (block.attachment.name ?? block.attachment.mediaType) + ']')
    else if (block.type === 'file') parts.push('[file ' + block.attachment.name + ']')
    else parts.push(`[${block.type}]`)
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
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'user') {
          blocks.push({ kind: 'user', text: contentText(event.data.content) })
        } else {
          const text = contentText(event.data.content)
          if (text.trim() !== '') {
            const label = 'plugin' in source && typeof source.plugin === 'string'
              ? source.plugin
              : source.kind
            blocks.push({ kind: 'context', label, text })
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
          })
        } else if (reason.kind === 'aborted') {
          blocks.push({ kind: 'notice', tone: 'warning', text: 'Turn cancelled' })
        } else if (reason.kind === 'max-tokens') {
          blocks.push({ kind: 'notice', tone: 'warning', text: 'Turn stopped at the output-token limit' })
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
    const blocks = [...reduceTranscript(this.entries, this.options), ...this.extra]
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
    const bar = (text: string, style: (line: string) => string = line => palette.dim('│ ' + line)): string =>
      text.split('\n').map(style).join('\n')
    switch (block.kind) {
      case 'user':
        return new Text(
          palette.bold(palette.accent('▌ You')) + '\n'
          + bar(block.text, line => palette.accent('│ ') + line),
          0,
          0,
        )
      case 'assistant': {
        const container = new Container()
        const label = palette.bold(palette.accent('◆ assistant'))
          + (block.live === true ? '  ' + palette.warning('streaming') : '')
        container.addChild(new Text(label, 0, 0))
        if (block.reasoning !== undefined && block.reasoning.trim() !== '') {
          container.addChild(new Spacer(1))
          container.addChild(new Text(
            palette.dim('thinking') + '\n' + bar(clip(block.reasoning, REASONING_PREVIEW), line => palette.dim('│ ' + line)),
            0,
            0,
          ))
        }
        if (block.text.trim() !== '') {
          container.addChild(new Spacer(1))
          container.addChild(new Markdown(block.text, 0, 0, this.options.markdown))
        }
        return container
      }
      case 'context':
        return new Text(
          palette.dim('◇ context · ' + block.label) + '\n'
          + bar(clip(block.text), line => palette.dim('│ ' + line)),
          0,
          0,
        )
      case 'tool': {
        const status = block.pending ? palette.warning('running') : block.isError === true ? palette.error('error') : palette.success('done')
        const lines = [palette.bold(palette.accent('⚙ ' + block.name)) + '  ' + status]
        if (block.args.trim() !== '') {
          lines.push(palette.dim('├ args'))
          lines.push(bar(clip(block.args), line => palette.dim('│ ' + line)))
        }
        if (block.result !== undefined && block.result.trim() !== '') {
          lines.push(palette.dim('├ result'))
          lines.push(bar(
            clip(block.result),
            block.isError === true ? line => palette.error('│ ' + line) : line => palette.dim('│ ') + line,
          ))
        }
        if (block.diffs !== undefined) {
          lines.push(palette.dim('├ diff'))
          for (const diff of block.diffs) {
            lines.push(palette.bold(palette.accent('│ diff ' + diff.path)))
            for (const row of diffLines(diff.oldText, diff.newText, 60)) {
              lines.push(row.kind === 'add'
                ? palette.success('│ + ' + row.text)
                : row.kind === 'remove' ? palette.error('│ - ' + row.text) : palette.dim('│   ' + row.text))
            }
          }
        }
        return new Text(lines.join('\n'), 0, 0)
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