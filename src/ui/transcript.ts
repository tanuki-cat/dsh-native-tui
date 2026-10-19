import type { MarkdownTheme } from '@earendil-works/pi-tui'
import { assembleAssistantStream, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
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
import type { DisplayMode } from '../config.js'
import { asFileDiffs, type FileDiff } from './diff.js'
import { clip } from './tool-preview.js'
import { REASONING_REVEAL_RECENT_MS, reasoningRevealFrom, rememberRevealProgress, revealCompletedReasoning, revealDurableReasoning, type RevealProgress } from './reasoning-reveal.js'
import { isCodeExecutionTool } from './transcript-render.js'

/** Streaming frame interval bounds, in milliseconds. */
export const STREAM_MIN_INTERVAL_MS = 33
const STREAM_MAX_INTERVAL_MS = 100
/** Estimated frame cost above which the stream interval backs off. */
const STREAM_FRAME_BUDGET_MS = 8
/**
 * Grace after an assistant block's last content before the rows that follow it
 * are shown. One paint interval is at most {@link STREAM_MAX_INTERVAL_MS}, so a
 * shorter grace would let the final thinking text and the tool card that
 * follows it land on the same frame, which reads as the thinking ending and
 * the card appearing at once.
 */
const ASSISTANT_SETTLE_MS = STREAM_MAX_INTERVAL_MS + 50
/**
 * Estimated milliseconds pi-tui spends re-rendering one character of streaming
 * Markdown. The reducer cannot measure that render, so the caller estimates it
 * from the live block's size to decide the next frame interval.
 */
export const STREAM_MS_PER_CHAR = 0.00025

/**
 * Next streaming frame interval for one measured rebuild. A frame that runs
 * over budget widens the interval so later frames stay complete on a busy
 * terminal; a cheap frame narrows it back toward the streaming floor.
 * @param current - the interval the measured frame used.
 * @param frameMs - estimated cost of that frame, including the live Markdown render.
 * @returns the interval to use for the next stream frame.
 */
export function nextStreamInterval(current: number, frameMs: number): number {
  const scaled = frameMs > STREAM_FRAME_BUDGET_MS ? current * 1.5 : current * 0.75
  return Math.max(STREAM_MIN_INTERVAL_MS, Math.min(STREAM_MAX_INTERVAL_MS, Math.round(scaled)))
}
/** One rendered transcript row. */
export type TranscriptBlock = ({
  readonly kind: 'user'; readonly text: string
} | {
  readonly kind: 'assistant'
  readonly text: string
  readonly reasoning?: string
  readonly live: boolean
  /** True while the reasoning block is open but has no content yet. */
  readonly starting?: boolean
  /** True while this block's completed reasoning is still being revealed. */
  readonly revealing?: boolean
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
  /** Tool output was pruned from the model-visible surface. */
  readonly pruned?: boolean
  readonly diffs?: readonly FileDiff[]
} | {
  readonly kind: 'notice'; readonly tone: 'info' | 'warning' | 'error'; readonly text: string
} | {
  /**
   * Transient model-wait row: a request is in flight and nothing streamed from
   * it yet. The application synthesizes it, never the reducer, so it carries
   * no seq and is rebuilt rather than reused.
   */
  readonly kind: 'waiting'; readonly text: string
} | {
  readonly kind: 'compaction'
  readonly compactionId: string
  readonly state: 'running' | 'done' | 'error'
  readonly shadowedItems?: number
  readonly shadowedTokens?: number
  readonly summary?: string
  readonly error?: string
}) & {
  /** Durable event sequence that produced this block. */
  readonly seq?: number
  /** Local notice placement: show after this durable sequence. */
  readonly afterSeq?: number
}

/** Session-level tool identities that must survive transcript window slicing. */
export interface ToolCallMemory {
  /** Calls that already produced their one durable result. */
  readonly settled: Set<string>
  /** Calls whose output was pruned from the model-visible surface. */
  readonly pruned: Set<string>
  /** Event sequences whose result/call was pruned. */
  readonly prunedSeqs: Set<number>
  /** Event sequence to call identity for calls and results. */
  readonly callBySeq: Map<number, string>
}

/** Options controlling transcript reduction. */
export interface TranscriptOptions {
  readonly showReasoning: boolean
  readonly thinkingDisplay?: DisplayMode
  readonly runCodeDisplay?: DisplayMode
  readonly maxEntries: number
  readonly palette: Palette
  readonly markdown: MarkdownTheme
  /**
   * Per-step reveal clocks for the interactive renderer. Direct reducers omit
   * it and use the block-end timestamp as before; the renderer supplies it so
   * a delayed first frame starts at one grapheme instead of skipping ahead.
   */
  readonly revealProgress?: Map<string, RevealProgress>
  /**
   * Session-level tool dedupe/prune memory. The renderer supplies it so a late
   * duplicate result cannot revive a call whose original events were sliced out
   * of the retained transcript window.
   */
  readonly toolMemory?: ToolCallMemory
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

/**
 * Assemble the safely finalizable prefix of one settled attempt stream.
 * An `assistant/attempt` settles a model attempt that never became an
 * assistant message, so its compact stream is the only record of what the
 * model produced. Tool calls are excluded: an interrupted attempt precedes
 * dispatch, so retaining one would show a call that never ran.
 * @param stream - compact records from a durable `assistant/attempt`.
 * @returns the visible content blocks, empty when the stream is unusable.
 */
function attemptContent(stream: readonly AssistantStreamRecord[] | undefined): readonly ContentBlock[] {
  if (stream === undefined || stream.length === 0) return []
  try {
    return assembleAssistantStream(stream).interruptedBlocks()
  }
  catch {
    // A malformed settlement must not take the whole transcript down.
    return []
  }
}

function toolResultText(message: { readonly content?: readonly ContentBlock[] }): string {
  return contentText(message.content)
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/**
 * Whether a row ends the reveal hold because showing it late would hide
 * information: fresh user input and a failed or truncated turn.
 * @param block - one reduced block after a still-revealing reasoning block.
 * @returns true when the hold must give way.
 */
function isRevealBoundary(block: TranscriptBlock): boolean {
  return block.kind === 'user' || (block.kind === 'notice' && block.tone !== 'info')
}

function reasoningKey(turn: number, step: number): string {
  return 'reasoning:' + stepKey(turn, step)
}

/**
 * Whether one transient chunk proves the model started producing content the
 * live transcript can show. A bare block-start must not hide the wait row
 * before any content exists; tool calls and images are shown by their durable
 * events, which clear the row themselves.
 * @param chunk - one live assistant stream chunk.
 * @param showReasoning - false when the thinking display is hidden.
 * @returns true for a non-empty text/reasoning delta or block.
 */
export function liveChunkHasOutput(chunk: StreamChunk, showReasoning = true): boolean {
  switch (chunk.type) {
    case 'text-delta':
      return chunk.text.trim() !== ''
    case 'reasoning-delta':
      return showReasoning && chunk.text.trim() !== ''
    case 'block-end':
      if (chunk.block.type === 'text') return chunk.block.text.trim() !== ''
      if (chunk.block.type === 'reasoning') return showReasoning && chunk.block.text.trim() !== ''
      return false
    default:
      return false
  }
}

/** One reduction plus the entry prefix no retained block still needs. */
export interface TranscriptReduction {
  /** Rendered transcript blocks, oldest first. */
  readonly blocks: TranscriptBlock[]
  /**
   * Index into the reduced entries of the oldest entry a retained block needs.
   * Earlier entries produced only blocks that this reduction dropped, so a
   * caller may discard them and re-reduce a bounded window next time.
   */
  readonly retainedFrom: number
  /** True while a completed reasoning block is still being revealed. */
  readonly revealPending: boolean
}

/**
 * Fold the Client event window into terminal rows. The reducer is intentionally
 * independent from pi-tui so it can be unit-tested without a terminal.
 * @param entries - contiguous durable and transient event window.
 * @param options - display limits and palette.
 * @param now - wall clock for revealing a completed reasoning block; defaults to now.
 * @returns rendered transcript blocks, oldest first.
 */
export function reduceTranscript(
  entries: readonly TranscriptEntry[],
  options: TranscriptOptions,
  now = Date.now(),
): TranscriptBlock[] {
  return reduceTranscriptWindow(entries, options, now).blocks
}

/**
 * Fold {@link reduceTranscript}'s window and report how much of it survives.
 * @param entries - contiguous durable and transient event window.
 * @param options - display limits and palette.
 * @param now - wall clock for revealing a completed reasoning block; defaults to now.
 * @returns the rendered blocks and the oldest entry a retained block needs.
 */
export function reduceTranscriptWindow(
  entries: readonly TranscriptEntry[],
  options: TranscriptOptions,
  now = Date.now(),
): TranscriptReduction {
  const blocks: TranscriptBlock[] = []
  /** Entry index that created each block, parallel to `blocks`; every event appends at most one. */
  const sources: number[] = []
  /**
   * Wall clock of the last content an assistant block received, parallel to
   * `blocks`. Rows that follow a block are held until this is one paint old, so
   * the final thinking text never shares a frame with the tool card after it.
   */
  const contentAt: number[] = []
  const liveByStep = new Map<string, { index: number; text: string; reasoning: string; revealing: boolean; starting: boolean }>()
  let durableRevealPending = false
  const finalizedSteps = new Set<string>()
  /** Steps that already opened a live block, so a retry is recognisable. */
  const startedSteps = new Set<string>()
  const toolByCall = new Map<string, number>()
  const hiddenCodeExecutionCalls = new Set<string>()
  /** Event sequence -> call identity, for both tool calls and tool results. */
  const settledCalls = options.toolMemory?.settled ?? new Set<string>()
  const callIdBySeq = options.toolMemory?.callBySeq ?? new Map<number, string>()
  const prunedSeqs = options.toolMemory?.prunedSeqs ?? new Set<number>()
  const prunedCalls = options.toolMemory?.pruned ?? new Set<string>()
  const thinkingDisplay = options.thinkingDisplay ?? 'detailed'
  const runCodeDisplay = options.runCodeDisplay ?? 'detailed'
  const showReasoning = thinkingDisplay !== 'hidden' && (options.thinkingDisplay !== undefined || options.showReasoning)
  const compactionByCall = new Map<string, number>()
  const revealDurable = (
    text: string,
    stream: readonly AssistantStreamRecord[] | undefined,
    key: string,
  ): { readonly text: string; readonly pending: boolean } => {
    if (!showReasoning || text.trim() === '') return { text, pending: false }
    const from = reasoningRevealFrom(stream)
    const progressKey = 'reasoning:' + key
    let progress = options.revealProgress?.get(progressKey)
    if (options.revealProgress !== undefined && progress === undefined && from !== undefined
      && now - from <= REASONING_REVEAL_RECENT_MS) {
      progress = { start: now, visible: 0 }
      rememberRevealProgress(options.revealProgress, progressKey, progress)
    }
    // Only the detailed display shows the whole block, so only it pays for the
    // local reveal; compact shows one line and must not hold later rows.
    return revealDurableReasoning(text, from, now, showReasoning && thinkingDisplay === 'detailed', progress, options.revealProgress !== undefined)
  }
  const finishOpenCompactions = (seq: number): void => {
    for (const index of compactionByCall.values()) {
      const prior = blocks[index]
      if (prior?.kind === 'compaction' && prior.state === 'running') {
        blocks[index] = { ...prior, state: 'error', error: 'Compaction did not finish', seq }
      }
    }
  }

  const pushLive = (event: LiveChunkEntry): void => {
    const key = stepKey(event.data.turn, event.data.step)
    if (finalizedSteps.has(key)) return
    let live = liveByStep.get(key)
    if (live === undefined) {
      const index = blocks.length
      blocks.push({ kind: 'assistant', text: '', reasoning: '', live: true })
      live = { index, text: '', reasoning: '', revealing: false, starting: false }
      liveByStep.set(key, live)
      // A step only starts a second live block when a retry took over from the
      // previous attempt. Its reasoning must reveal from the start instead of
      // inheriting the settled attempt's completed count.
      if (startedSteps.has(key)) options.revealProgress?.delete(reasoningKey(event.data.turn, event.data.step))
      startedSteps.add(key)
    }
    const chunk: StreamChunk = event.data.chunk
    if (chunk.type === 'block-start') {
      // A reasoning block can stay open for a long time before its content
      // arrives. Keep an empty-but-visible row so the page does not sit blank
      // and then pop in a whole block.
      if (chunk.blockType === 'reasoning' && showReasoning) live.starting = true
    }
    else if (chunk.type === 'text-delta') {
      live.starting = false
      live.text += chunk.text
    }
    else if (chunk.type === 'reasoning-delta' && showReasoning) {
      live.starting = false
      live.reasoning += chunk.text
    }
    else if (chunk.type === 'block-end') {
      live.starting = false
      if (chunk.block.type === 'text' && chunk.block.text.length >= live.text.length) {
        live.text = chunk.block.text
      }
      else if (chunk.block.type === 'reasoning' && showReasoning && chunk.block.text.trim() !== '') {
        const completed = chunk.block.text
        if (live.reasoning === '') {
          // Some Responses-compatible gateways send no reasoning deltas, only the
          // terminal block. Reveal that block over frames instead of popping it in.
          const progressKey = reasoningKey(event.data.turn, event.data.step)
          let progress = options.revealProgress?.get(progressKey)
          if (options.revealProgress !== undefined && progress === undefined) {
            progress = { start: now, visible: 0 }
            rememberRevealProgress(options.revealProgress, progressKey, progress)
          }
          const reveal = thinkingDisplay === 'detailed'
            ? revealCompletedReasoning(completed, now, progress, event.time)
            : { text: completed, pending: false }
          live.reasoning = reveal.text
          live.revealing = reveal.pending
        }
        else {
          if (completed.length >= live.reasoning.length) live.reasoning = completed
          live.revealing = false
        }
      }
    }
    contentAt[live.index] = event.time
    blocks[live.index] = {
      kind: 'assistant',
      text: live.text,
      ...(live.reasoning === '' ? {} : { reasoning: live.reasoning }),
      live: true,
      ...(live.starting ? { starting: true } : {}),
      ...(live.revealing ? { revealing: true } : {}),
    }
  }

  for (let position = 0; position < entries.length; position += 1) {
    // Attribute every block the previous entry appended to that entry.
    while (sources.length < blocks.length) sources.push(position - 1)
    const entry = entries[position]!
    if (entry.type === 'live') {
      pushLive(entry.event)
      continue
    }
    const event: SessionEvent = entry.event
    const seq = Number(event.seq)
    const extensionType = (event as unknown as { type: string }).type
    if (extensionType.startsWith('compaction/')) {
      const data = (event as unknown as { data: Record<string, unknown> }).data
      if (extensionType === 'compaction/start') {
        finishOpenCompactions(seq)
        const id = String(data.compactionId)
        compactionByCall.set(id, blocks.length)
        blocks.push({ kind: 'compaction', compactionId: id, state: 'running', seq })
      }
      else if (extensionType === 'compaction/summary') {
        const id = String(data.compactionId)
        const summary = clip(contentText(data.summary as readonly ContentBlock[] | undefined), 800)
        const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
        const range = data.shadowedRange as { readonly start?: unknown; readonly end?: unknown } | undefined
        const rangeCount = typeof range?.start === 'number' && typeof range.end === 'number'
          ? Math.max(0, range.end - range.start + 1)
          : 0
        const block: TranscriptBlock = {
          kind: 'compaction',
          compactionId: id,
          state: 'running',
          shadowedItems: shadowedSeqs.length > 0 ? shadowedSeqs.length : rangeCount,
          ...(typeof data.shadowedTokenCount === 'number' ? { shadowedTokens: data.shadowedTokenCount } : {}),
          ...(summary === '' ? {} : { summary }),
          seq,
        }
        const index = compactionByCall.get(id)
        if (index === undefined) {
          compactionByCall.set(id, blocks.length)
          blocks.push(block)
        }
        else {
          blocks[index] = block
        }
      }
      else if (extensionType === 'compaction/end') {
        const id = String(data.compactionId)
        const error = typeof data.error === 'string' ? data.error : undefined
        const index = compactionByCall.get(id)
        if (index === undefined) {
          blocks.push({ kind: 'compaction', compactionId: id, state: error === undefined ? 'done' : 'error', ...(error === undefined ? {} : { error }), seq })
        }
        else {
          const prior = blocks[index]
          if (prior?.kind === 'compaction') {
            blocks[index] = { ...prior, state: error === undefined ? 'done' : 'error', ...(error === undefined ? {} : { error }), seq }
          }
        }
      }
      else if (extensionType === 'compaction/prune') {
        const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
        for (const value of shadowedSeqs) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue
          prunedSeqs.add(value)
          const callId = callIdBySeq.get(value)
          if (callId === undefined) continue
          prunedCalls.add(callId)
          const index = toolByCall.get(callId)
          if (index !== undefined) {
            const prior = blocks[index]
            if (prior?.kind === 'tool') {
              blocks[index] = {
                ...prior,
                result: undefined,
                diffs: undefined,
                pending: false,
                pruned: true,
              }
            }
          }
        }
        const count = shadowedSeqs.length
        const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
        blocks.push({ kind: 'notice', tone: 'info', text: 'Tool output pruned · ' + String(count) + ' item(s) · ~' + String(tokens) + ' tokens', seq })
      }
      continue
    }
    if (event.type === 'assistant/message' || event.type === 'turn/end') finishOpenCompactions(seq)
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'user') {
          blocks.push({ kind: 'user', text: contentText(event.data.content), seq })
        }
        else if (String(source.kind) === 'compact-checkpoint') {
          // The Host injects the checkpoint as model context as well as emitting
          // compaction/summary. The card already shows the summary; keep only a
          // short context row when the matching card is outside the window.
          const compactionId = (source as unknown as { readonly compactionId?: unknown }).compactionId
          if (typeof compactionId === 'string' && compactionByCall.has(compactionId)) break
          const text = contentText(event.data.content)
          if (text.trim() !== '') {
            blocks.push({ kind: 'context', label: 'compact-checkpoint', text: clip(text, 240), seq })
          }
        }
        else {
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
          live.revealing = false
          blocks[live.index] = { kind: 'assistant', text: '', live: true }
        }
        const text = contentText(event.data.message.content)
        const fullReasoning = showReasoning ? contentReasoning(event.data.message.content) : ''
        const reveal = revealDurable(fullReasoning, event.data.stream, key)
        if (reveal.pending) durableRevealPending = true
        if (text.trim() !== '' || fullReasoning.trim() !== '') {
          contentAt[blocks.length] = event.time
          blocks.push({
            kind: 'assistant',
            text,
            ...(reveal.text === '' ? {} : { reasoning: reveal.text }),
            live: false,
            ...(reveal.pending ? { revealing: true } : {}),
            seq,
          })
        }
        break
      }
      case 'assistant/attempt': {
        const key = stepKey(event.data.turn, event.data.step)
        // A retry restarts the same step with a different attempt; keeping this
        // clock would let the retried block reveal from the old attempt's count.
        options.revealProgress?.delete(reasoningKey(event.data.turn, event.data.step))
        const live = liveByStep.get(key)
        if (live !== undefined) {
          // Settle the transient rows and drop the accumulator so a retry of the
          // same step streams into a fresh block instead of being suppressed.
          live.revealing = false
          blocks[live.index] = { kind: 'assistant', text: '', live: true }
          liveByStep.delete(key)
        }
        const content = attemptContent(event.data.stream)
        const text = contentText(content)
        const fullReasoning = showReasoning ? contentReasoning(content) : ''
        const reveal = revealDurable(fullReasoning, event.data.stream, key)
        if (reveal.pending) durableRevealPending = true
        if (text.trim() !== '' || fullReasoning.trim() !== '') {
          contentAt[blocks.length] = event.time
          blocks.push({
            kind: 'assistant',
            text,
            ...(reveal.text === '' ? {} : { reasoning: reveal.text }),
            live: false,
            ...(reveal.pending ? { revealing: true } : {}),
            seq,
          })
        }
        break
      }
      case 'tool/call': {
        const callId = event.data.callId
        const seenSeq = callIdBySeq.get(seq) === callId
        const knownCall = seenSeq ? false : [...callIdBySeq.values()].some(value => value === callId)
        callIdBySeq.set(seq, callId)
        if (prunedSeqs.has(seq) || prunedCalls.has(callId)) {
          prunedCalls.add(callId)
          break
        }
        // A resumed/replayed call must not add a second card or overwrite the
        // result mapping of the card that already exists. A normal rebuild sees
        // its original seq, so persistent settlement must not suppress it.
        if (toolByCall.has(callId) || hiddenCodeExecutionCalls.has(callId)) break
        if (!seenSeq && (settledCalls.has(callId) || knownCall)) break
        if (runCodeDisplay === 'hidden' && isCodeExecutionTool(event.data.name)) {
          hiddenCodeExecutionCalls.add(callId)
          break
        }
        const index = blocks.length
        toolByCall.set(callId, index)
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
        const seenSeq = callIdBySeq.get(seq) === callId
        callIdBySeq.set(seq, callId)
        // A duplicate result after a session resume/replay must not revive a
        // call that was already settled or whose output was pruned.
        if (hiddenCodeExecutionCalls.has(callId)) {
          settledCalls.add(callId)
          break
        }
        if (prunedSeqs.has(seq) || prunedCalls.has(callId)) {
          prunedCalls.add(callId)
          break
        }
        // Rebuilds replay the same seq and must render the original result;
        // only a new seq for an already settled call is a duplicate.
        if (!seenSeq && settledCalls.has(callId)) break
        const index = toolByCall.get(callId)
        const prior = index === undefined ? undefined : blocks[index]
        if (prior?.kind === 'tool' && prior.pending === false) {
          settledCalls.add(callId)
          break
        }
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
        } else if (prior?.kind === 'tool') {
          blocks[index] = {
            ...prior,
            result,
            ...(isError ? { isError: true } : {}),
            ...(diffs === undefined ? {} : { diffs }),
            pending: false,
            seq,
          }
        }
        settledCalls.add(callId)
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

  while (sources.length < blocks.length) sources.push(entries.length - 1)
  const revealPending = durableRevealPending || [...liveByStep.values()].some(live => live.revealing)
  const visible: TranscriptBlock[] = []
  const visibleSources: number[] = []
  let holdAfterReveal = false
  /** Latest assistant content already emitted above the current row. */
  let lastAssistantAt: number | undefined
  let settleHeld = false
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    // A reasoning block that is still revealing keeps the rows after it back,
    // so a tool card or the next step does not overtake the thinking text. The
    // hold ends at the first row that must not be hidden -- a new user message
    // or a warning/error notice -- and everything from that row on is shown in
    // event order. Rows that arrived before the boundary stay held, so a tool
    // card that preceded the failure cannot leak out ahead of the thinking.
    const boundary = isRevealBoundary(block)
    if (holdAfterReveal && !boundary) continue
    if (holdAfterReveal) holdAfterReveal = false
    // Content produced after an assistant block must not share its last frame.
    // A delta path has no local reveal, yet its final thinking text and the
    // tool call that follows it arrive within milliseconds, so without this
    // grace the two land on the same paint and the card looks like it appeared
    // the instant the thinking finished.
    const previousAssistantAt = lastAssistantAt
    if (previousAssistantAt !== undefined
      && (block.kind === 'tool' || block.kind === 'compaction'
        || (block.kind === 'notice' && block.tone === 'info'))
      && now - previousAssistantAt < ASSISTANT_SETTLE_MS) {
      settleHeld = true
      continue
    }
    // A pruned tool row only repeats the prune notice; hiding the whole card
    // keeps the transcript focused on content that is still model-visible.
    if (block.kind === 'tool' && block.pruned === true) continue
    if (block.kind === 'assistant' && block.text === '' && (block.reasoning ?? '') === ''
      && block.starting !== true) continue
    visible.push(block)
    visibleSources.push(sources[index] ?? 0)
    if (block.kind === 'assistant') {
      if (block.revealing === true) holdAfterReveal = true
      const at = contentAt[index]
      if (at !== undefined) lastAssistantAt = at
    }
    // The grace only covers rows that directly follow the assistant block; a
    // new user turn, a failure and any other row end that adjacency.
    else lastAssistantAt = undefined
  }
  const pending = revealPending || settleHeld
  if (visible.length <= options.maxEntries) {
    return { blocks: visible, retainedFrom: visibleSources[0] ?? 0, revealPending: pending }
  }
  const start = visible.length - options.maxEntries
  const hidden = visible.length - options.maxEntries
  return {
    blocks: [
      { kind: 'notice', tone: 'info', text: `… ${String(hidden)} earlier transcript entries hidden …` },
      ...visible.slice(start),
    ],
    retainedFrom: visibleSources[start] ?? 0,
    revealPending: pending,
  }
}
