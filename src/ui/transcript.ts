import { Box, Container, Markdown, Spacer, Text, type Component, type MarkdownTheme } from '@earendil-works/pi-tui'
import { Rule } from './rule.js'
import { BarText } from './bar-text.js'
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
import { asFileDiffs, diffLines, type FileDiff } from './diff.js'
import { clip, compactCodeExecutionPreview, formatToolArguments } from './tool-preview.js'
import { clipGraphemes, REASONING_PREVIEW, REASONING_REVEAL_RECENT_MS, reasoningRevealFrom, revealCompletedReasoning, revealDurableReasoning, type RevealProgress } from './reasoning-reveal.js'

/** Streaming frame interval bounds, in milliseconds. */
export const STREAM_MIN_INTERVAL_MS = 33
const STREAM_MAX_INTERVAL_MS = 100
/** Estimated frame cost above which the stream interval backs off. */
const STREAM_FRAME_BUDGET_MS = 8
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
/** Tools whose cards follow the code-execution density setting. */
const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['run_code', 'bash', 'pwsh'])

function isCodeExecutionTool(name: string): boolean {
  return CODE_EXECUTION_TOOLS.has(name)
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
  const liveByStep = new Map<string, { index: number; text: string; reasoning: string; revealing: boolean; starting: boolean }>()
  let durableRevealPending = false
  const finalizedSteps = new Set<string>()
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
      options.revealProgress.set(progressKey, progress)
    }
    return revealDurableReasoning(text, from, now, showReasoning, progress, options.revealProgress !== undefined)
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
            options.revealProgress.set(progressKey, progress)
          }
          const reveal = revealCompletedReasoning(completed, now, progress, event.time)
          live.reasoning = reveal.text
          live.revealing = reveal.pending
        }
        else {
          if (completed.length >= live.reasoning.length) live.reasoning = completed
          live.revealing = false
        }
      }
    }
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
  // A new user turn or a warning/error notice outranks the local reveal:
  // showing it immediately preserves event order and avoids hiding fresh input
  // or a failure. Informational notices stay behind the reveal like tool rows.
  const revealIndex = blocks.findIndex(block => block.kind === 'assistant' && block.revealing === true)
  const boundaryAfterReveal = revealIndex !== -1
    && blocks.slice(revealIndex + 1).some(block =>
      block.kind === 'user' || (block.kind === 'notice' && block.tone !== 'info'))
  for (let index = 0; index < blocks.length; index += 1) {
    // Do not let the next tool card or step overtake a thinking block that is
    // still revealing locally. The held entries stay in the window and appear
    // on the frame that completes the reveal.
    if (holdAfterReveal && !boundaryAfterReveal) continue
    const block = blocks[index]!
    // A pruned tool row only repeats the prune notice; hiding the whole card
    // keeps the transcript focused on content that is still model-visible.
    if (block.kind === 'tool' && block.pruned === true) continue
    if (block.kind === 'assistant' && block.text === '' && (block.reasoning ?? '') === ''
      && block.starting !== true) continue
    visible.push(block)
    visibleSources.push(sources[index] ?? 0)
    if (block.kind === 'assistant' && block.revealing === true) holdAfterReveal = true
  }
  if (visible.length <= options.maxEntries) {
    return { blocks: visible, retainedFrom: visibleSources[0] ?? 0, revealPending }
  }
  const start = visible.length - options.maxEntries
  const hidden = visible.length - options.maxEntries
  return {
    blocks: [
      { kind: 'notice', tone: 'info', text: `… ${String(hidden)} earlier transcript entries hidden …` },
      ...visible.slice(start),
    ],
    retainedFrom: visibleSources[start] ?? 0,
    revealPending,
  }
}

/**
 * Whether a rebuilt block renders exactly what its predecessor rendered.
 * Blocks are pure data, so a field-wise comparison decides it without
 * touching the component tree. Arrays compare by length and element identity,
 * which fails safe: a false negative only rebuilds one component.
 * @param left - block from the previous rebuild.
 * @param right - block from the current rebuild.
 * @returns true when the previous component can be reused.
 */
export function sameTranscriptBlock(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  const previous = right as unknown as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(previous).length) return false
  for (const key of keys) {
    const before = (left as unknown as Record<string, unknown>)[key]
    const after = previous[key]
    if (before === after) continue
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) return false
      for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) return false
      continue
    }
    return false
  }
  return true
}

/**
 * Stable identity of one reduced block, for carrying its component across a
 * rebuild. `maxEntries` drops old rows from the front and shifts every later
 * block's index, so index alignment cannot decide reuse. A live assistant
 * block has no durable identity and is rebuilt every frame by design.
 * @param block - one reduced block.
 * @returns a key stable for the block's lifetime, or undefined when it has none.
 */
function blockKey(block: TranscriptBlock): string | undefined {
  switch (block.kind) {
    case 'tool': return 'tool:' + block.callId
    case 'compaction': return 'compaction:' + block.compactionId
    case 'assistant': return block.live || block.seq === undefined ? undefined : 'assistant:' + String(block.seq)
    case 'user': return block.seq === undefined ? undefined : 'user:' + String(block.seq)
    case 'context': return block.seq === undefined ? undefined : 'context:' + String(block.seq)
    case 'notice': return block.seq === undefined ? undefined : 'notice:' + String(block.seq)
    case 'waiting': return undefined
  }
}

/** Pi-tui renderer for one reduced transcript. */
export class TranscriptRenderer {
  readonly container = new Container()
  private entries: readonly TranscriptEntry[] = []
  private extra: readonly TranscriptBlock[] = []
  /** Component per stable block identity from the previous rebuild. */
  private cached = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
  private retained = 0
  private liveChars = 0
  private revealPending = false
  private options: TranscriptOptions

  /**
   * Index into the last reduced event window below which no retained block
   * needs anything. A caller may drop that prefix before the next rebuild.
   */
  get retainedFrom(): number {
    return this.retained
  }

  /** Characters in the trailing live assistant block; its re-render dominates a stream frame. */
  get liveContentLength(): number {
    return this.liveChars
  }

  /** True while a completed reasoning block is still being revealed across frames. */
  get liveRevealPending(): boolean {
    return this.revealPending
  }

  /**
   * @param options - reduction and styling options.
   */
  constructor(options: TranscriptOptions) {
    this.options = {
      ...options,
      revealProgress: options.revealProgress ?? new Map(),
      toolMemory: options.toolMemory ?? {
        settled: new Set(),
        pruned: new Set(),
        prunedSeqs: new Set(),
        callBySeq: new Map(),
      },
    }
  }

  /** Switch reasoning/code-execution density and rebuild the existing event window. */
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void {
    if (this.options.thinkingDisplay === thinkingDisplay && this.options.runCodeDisplay === runCodeDisplay) return
    this.options = { ...this.options, thinkingDisplay, runCodeDisplay }
    // Density is a render option rather than part of TranscriptBlock, so a block
    // can stay equal while its component must switch representation. Drop the
    // reuse window; otherwise the previous density keeps rendering.
    this.cached.clear()
    this.rebuild()
  }

  /** Change the retained transcript row budget and rebuild. */
  setMaxEntries(maxEntries: number): void {
    this.options = { ...this.options, maxEntries }
    this.rebuild()
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
    this.revealPending = false
    this.options.revealProgress?.clear()
    this.options.toolMemory?.settled.clear()
    this.options.toolMemory?.pruned.clear()
    this.options.toolMemory?.prunedSeqs.clear()
    this.options.toolMemory?.callBySeq.clear()
    this.cached.clear()
    this.container.clear()
  }

  private rebuild(): void {
    const reduction = reduceTranscriptWindow(this.entries, this.options)
    this.retained = reduction.retainedFrom
    this.revealPending = reduction.revealPending
    const durable = reduction.blocks
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
    const next = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
    let liveChars = 0
    this.container.clear()
    for (const [index, block] of blocks.entries()) {
      if (block.kind === 'assistant' && block.live) liveChars += block.text.length + (block.reasoning?.length ?? 0)
      if (index > 0) this.container.addChild(new Spacer(1))
      if (index > 0 && block.kind === 'user') {
        this.container.addChild(new Rule(this.options.palette.dim))
        this.container.addChild(new Spacer(1))
      }
      const key = blockKey(block)
      const previous = key === undefined ? undefined : this.cached.get(key)
      // Streaming rewrites only the trailing live block. Reusing the rest by
      // identity keeps their parsed Markdown cached even when the window is full
      // and every block index just shifted by one.
      const component = previous !== undefined && sameTranscriptBlock(previous.block, block)
        ? previous.component
        : this.renderBlock(block)
      if (key !== undefined) next.set(key, { block, component })
      this.container.addChild(component)
    }
    this.cached = next
    this.liveChars = liveChars
  }

  private renderBlock(block: TranscriptBlock) {
    const palette = this.options.palette
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
      case 'assistant': {
        const container = new Container()
        const label = palette.bold(palette.accent('◆ assistant'))
          + (block.live === true ? '  ' + palette.warning('streaming') : '')
        container.addChild(new Text(label, 0, 0))
        const mode = this.options.thinkingDisplay ?? 'detailed'
        if (block.starting === true) {
          if (mode === 'compact') {
            container.addChild(new Spacer(1))
            container.addChild(new Text(palette.dim('thinking · …'), 0, 0))
          }
          else if (mode !== 'hidden') {
            const reasoning = new Container()
            reasoning.addChild(new Text(palette.dim('thinking …'), 0, 0))
            container.addChild(new Spacer(1))
            container.addChild(band(reasoning, palette.thinkingBand))
          }
        }
        else if (block.reasoning !== undefined && block.reasoning.trim() !== '') {
          if (mode === 'compact') {
            const firstLine = block.reasoning.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
            container.addChild(new Spacer(1))
            container.addChild(new Text(palette.dim('thinking · ' + clipGraphemes(firstLine, 240)), 0, 0))
          }
          else if (mode !== 'hidden') {
            const reasoning = new Container()
            reasoning.addChild(new Text(palette.dim('thinking'), 0, 0))
            reasoning.addChild(new Text(palette.dim(clipGraphemes(block.reasoning, REASONING_PREVIEW)), 0, 0))
            container.addChild(new Spacer(1))
            container.addChild(band(reasoning, palette.thinkingBand))
          }
        }
        if (block.text.trim() !== '' && block.revealing !== true) {
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
        if (isCodeExecutionTool(block.name) && (this.options.runCodeDisplay ?? 'detailed') === 'compact') {
          const preview = compactCodeExecutionPreview(block)
          return new Text(palette.bold(palette.accent('⚙ ' + block.name)) + '  ' + status
            + (preview === '' ? '' : '  ·  ' + palette.dim(preview)), 0, 0)
        }
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
        return band(container, palette.toolBand)
      }
      case 'compaction': {
        const container = new Container()
        const meta = [
          block.shadowedItems === undefined ? undefined : String(block.shadowedItems) + ' item(s)',
          block.shadowedTokens === undefined ? undefined : '~' + String(block.shadowedTokens) + ' tokens',
        ].filter((value): value is string => value !== undefined)
        const title = block.state === 'error'
          ? '✕ Compaction failed'
          : block.state === 'running' ? '⟳ Compacting context…' : '✓ Context compacted'
        container.addChild(new Text(palette.bold(palette.accent(title)) + (meta.length === 0 ? '' : '  ' + palette.dim(meta.join(' · '))), 0, 0))
        if (block.summary !== undefined && block.summary.trim() !== '') {
          container.addChild(new BarText(clip(block.summary, 800), '│ ', palette.dim, palette.dim))
        }
        if (block.error !== undefined) container.addChild(new Text(palette.error(clip(block.error, 600)), 0, 0))
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
}