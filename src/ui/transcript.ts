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
import { resultFileDiffs, type FileDiff } from './diff.js'
import { clip } from './tool-preview.js'
import { AssistantStream, type AssistantPart } from './transcript-stream.js'
import { isCodeExecutionTool } from './transcript-render.js'
import { trimTranscriptWindow } from './transcript-window.js'

/**
 * Nested PTC tools that always get their own card, including the pending row
 * before a result exists. Other sub-calls stay inside the parent `run_code`
 * card; showing every one would duplicate what that result already summarizes.
 */
const PTC_CARD_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** One rendered transcript row. */
export type TranscriptBlock = ({
  readonly kind: 'user'; readonly text: string
} | {
  readonly kind: 'assistant'
  readonly text: string
  readonly reasoning?: string
  readonly live: boolean
  /** Text and reasoning in provider order. Absent on local, manually constructed rows. */
  readonly content?: readonly AssistantPart[]
  readonly streamKey?: string
  /** True while the reasoning block is open but has no content yet. */
  readonly starting?: boolean
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
   * Transient execution/retry status. The application synthesizes it, never
   * the reducer, so it carries no seq and is rebuilt rather than reused.
   */
  readonly kind: 'waiting'; readonly text: string
} | {
  readonly kind: 'compaction'
  readonly compactionId: string
  /**
   * `interrupted` is a start with no matching end in a log that was reopened:
   * the process stopped before the compaction committed, and the resume marker
   * is what released its durable lock. It is not a summarizer failure, so it
   * reads differently from `error`.
   */
  readonly state: 'running' | 'done' | 'error' | 'interrupted'
  readonly shadowedItems?: number
  readonly shadowedTokens?: number
  readonly summary?: string
  readonly error?: string
}) & {
  /** Durable event sequence that produced this block. */
  readonly seq?: number
  /** Local notice placement: show after this durable sequence. */
  readonly afterSeq?: number
  /** Local notice placement: show after the assistant row this stream fed. */
  readonly afterStreamKey?: string
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
  /** Application-local keyboard toggle, not a persisted setting. */
  readonly writeExpanded?: boolean
  readonly maxEntries: number
  readonly palette: Palette
  readonly markdown: MarkdownTheme
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

/** Render a PTC sub-call's normalized JSON arguments through the native form. */
function ptcArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return ''
  }
}

/** Narrow a PTC settle payload's content to the blocks the transcript understands. */
function ptcContent(value: unknown): readonly ContentBlock[] | undefined {
  return Array.isArray(value) ? value as readonly ContentBlock[] : undefined
}

/** Identity of the assistant row one turn/step streams into. */
function liveStreamKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/**
 * Durable events that close the row a live chunk streamed into.
 *
 * Mirrors the reducer's `assistant/message`, `assistant/attempt` and `turn/end`
 * cases; a new settlement event must be added here as well.
 */
const LIVE_CLOSERS: ReadonlySet<string> = new Set(['assistant/message', 'assistant/attempt', 'turn/end'])

/**
 * Identity of the assistant row still streaming at the tail of `entries`.
 *
 * A local notice uses it to stay under the row it was raised from: that row has
 * no durable sequence yet, so sequence-based placement would lift the notice
 * above it.
 * @param entries - durable and transient entries, oldest first.
 * @returns the live row key, or undefined when nothing is streaming.
 */
export function streamingRowKey(entries: readonly TranscriptEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type === 'live') return liveStreamKey(entry.event.data.turn, entry.event.data.step)
    if (LIVE_CLOSERS.has(String(entry.event.type))) return undefined
  }
  return undefined
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
  return reduceTranscriptWindow(entries, options).blocks
}

/**
 * Fold {@link reduceTranscript}'s window and report how much of it survives.
 * @param entries - contiguous durable and transient event window.
 * @param options - display limits and palette.
 * @returns the rendered blocks and the oldest entry a retained block needs.
 */
export function reduceTranscriptWindow(
  entries: readonly TranscriptEntry[],
  options: TranscriptOptions,
): TranscriptReduction {
  const reducer = createTranscriptReducer(options)
  reducer.append(entries)
  return reducer.reduce()
}

/** Stateful event fold. Append immutable entries once; project as often as the UI paints. */
export function createTranscriptReducer(options: TranscriptOptions) {
  const blocks: TranscriptBlock[] = []
  /** Entry index that created each block, parallel to `blocks`; every event appends at most one. */
  const sources: number[] = []
  const liveByStep = new Map<string, number>()
  const assistants = new Map<number, AssistantStream>()
  const finalizedSteps = new Set<string>()
  const toolByCall = new Map<string, number>()
  const hiddenCodeExecutionCalls = new Set<string>()
  /** Event sequence -> call identity, for both tool calls and tool results. */
  const settledCalls = options.toolMemory?.settled ?? new Set<string>()
  const callIdBySeq = options.toolMemory?.callBySeq ?? new Map<number, string>()
  const prunedSeqs = options.toolMemory?.prunedSeqs ?? new Set<number>()
  const prunedCalls = options.toolMemory?.pruned ?? new Set<string>()
  const runCodeDisplay = options.runCodeDisplay ?? 'detailed'
  const compactionByCall = new Map<string, number>()
  /** PTC child call ids per parent `run_code`, so a pruned parent hides its cards. */
  const ptcByParent = new Map<string, Set<string>>()
  const rememberPtcChild = (parentCallId: string | undefined, subCallId: string): void => {
    if (parentCallId === undefined) return
    const children = ptcByParent.get(parentCallId) ?? new Set<string>()
    children.add(subCallId)
    ptcByParent.set(parentCallId, children)
  }
  /**
   * Why an open compaction ended at this event, or undefined when it does not
   * close one.
   *
   * A resume writes `turn/end{interrupted}` and then `session/end-seed`: the
   * turn closer is what releases the compaction lock, so the start it leaves
   * behind died with the previous process. Reaching any other boundary means
   * the log kept going and the summarizer itself failed.
   * @param event - one durable event.
   * @returns the state to close open compactions with, or undefined.
   */
  const compactionCloseState = (event: SessionEvent): 'error' | 'interrupted' | undefined => {
    const type = (event as unknown as { type: string }).type
    if (type === 'session/end-seed') return 'interrupted'
    if (type !== 'assistant/message' && type !== 'turn/end') return undefined
    const reason = type === 'turn/end'
      ? (event.data as { readonly reason?: { readonly kind?: unknown } }).reason
      : undefined
    return reason?.kind === 'interrupted' ? 'interrupted' : 'error'
  }
  /**
   * Close every compaction still marked running.
   * @param seq - event that closed them.
   * @param state - `error` when the log kept going past a start that never
   *   wrote its end, `interrupted` when the log was reopened instead.
   */
  const finishOpenCompactions = (seq: number, state: 'error' | 'interrupted' = 'error'): void => {
    for (const index of compactionByCall.values()) {
      const prior = blocks[index]
      if (prior?.kind !== 'compaction' || prior.state !== 'running') continue
      blocks[index] = state === 'interrupted'
        ? { ...prior, state: 'interrupted', seq }
        : { ...prior, state: 'error', error: 'Compaction did not finish', seq }
    }
  }

  const pushLive = (event: LiveChunkEntry): void => {
    const key = liveStreamKey(event.data.turn, event.data.step)
    if (finalizedSteps.has(key)) return
    let index = liveByStep.get(key)
    if (index === undefined) {
      index = blocks.length
      blocks.push({ kind: 'assistant', text: '', live: true })
      liveByStep.set(key, index)
      assistants.set(index, new AssistantStream(key, options))
    }
    assistants.get(index)!.append(event.data.chunk)
  }

  const append = (entries: readonly TranscriptEntry[], offset = 0): void => {
    for (let position = offset; position < entries.length; position += 1) {
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
            // A pruned run_code hides the write/edit cards it produced.
            for (const subCallId of ptcByParent.get(callId) ?? []) {
              prunedCalls.add(subCallId)
              const childIndex = toolByCall.get(subCallId)
              const child = childIndex === undefined ? undefined : blocks[childIndex]
              if (childIndex !== undefined && child?.kind === 'tool') {
                blocks[childIndex] = {
                  ...child,
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
      if (extensionType === 'tool/ptc-dispatch-start' || extensionType === 'tool/ptc-dispatch') {
        const data = (event as unknown as { readonly data?: Record<string, unknown> }).data
        const subCallId = data === undefined ? undefined : typeof data.subCallId === 'string' ? data.subCallId : undefined
        const parentCallId = data === undefined ? undefined : typeof data.parentCallId === 'string' ? data.parentCallId : undefined
        const name = data !== undefined && typeof data.name === 'string' && data.name !== '' ? data.name : 'tool'
        const settle = extensionType === 'tool/ptc-dispatch'
        const args = ptcArguments(data?.arguments)
        const diffs = settle ? resultFileDiffs(data?.meta, args) : undefined
        const pruned = subCallId === undefined || prunedSeqs.has(seq) || prunedCalls.has(subCallId)
          || (parentCallId !== undefined && prunedCalls.has(parentCallId))
        // Only file-editing sub-calls need their own card; the rest are already
        // summarized by the parent run_code result.
        if (subCallId !== undefined && !pruned && (PTC_CARD_TOOLS.has(name) || diffs !== undefined)) {
          const index = toolByCall.get(subCallId)
          const prior = index === undefined ? undefined : blocks[index]
          if (!settle) {
            if (index === undefined) {
              toolByCall.set(subCallId, blocks.length)
              callIdBySeq.set(seq, subCallId)
              blocks.push({ kind: 'tool', callId: subCallId, name, args, pending: true, seq })
              rememberPtcChild(parentCallId, subCallId)
            }
          }
          else if (!(prior?.kind === 'tool' && prior.pending === false)) {
            const settled: TranscriptBlock = {
              kind: 'tool',
              callId: subCallId,
              name,
              args,
              result: contentText(ptcContent(data?.content)),
              ...(data?.isError === true ? { isError: true } : {}),
              ...(diffs === undefined ? {} : { diffs }),
              pending: false,
              seq,
            }
            if (index === undefined) {
              toolByCall.set(subCallId, blocks.length)
              callIdBySeq.set(seq, subCallId)
              blocks.push(settled)
              rememberPtcChild(parentCallId, subCallId)
            }
            else if (prior?.kind === 'tool') {
              blocks[index] = { ...prior, ...settled }
            }
            settledCalls.add(subCallId)
          }
        }
        continue
      }
      const closeState = compactionCloseState(event)
      if (closeState !== undefined) finishOpenCompactions(seq, closeState)
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
          const key = liveStreamKey(event.data.turn, event.data.step)
          finalizedSteps.add(key)
          const index = liveByStep.get(key) ?? blocks.length
          const assistant = assistants.get(index) ?? new AssistantStream(key, options)
          assistant.settle(event.data.message.content, seq)
          assistants.set(index, assistant)
          blocks[index] = { kind: 'assistant', text: '', live: false, seq }
          liveByStep.delete(key)
          break
        }
        case 'assistant/attempt': {
          const key = liveStreamKey(event.data.turn, event.data.step)
          const index = liveByStep.get(key)
          if (index !== undefined) {
            assistants.delete(index)
            blocks[index] = { kind: 'assistant', text: '', live: false }
            liveByStep.delete(key)
          }
          // The attempt replaces the row the notice was raised under, so keep
          // that row's key for placement even though the stream has its own.
          const assistant = new AssistantStream(key + ':attempt:' + String(seq), options, key)
          assistant.settle(attemptContent(event.data.stream), seq)
          assistants.set(blocks.length, assistant)
          blocks.push({ kind: 'assistant', text: '', live: false, seq })
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
          const diffs = resultFileDiffs(event.data.meta, prior?.kind === 'tool' ? prior.args : '')
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
          } else if (reason.kind === 'interrupted') {
            // The Host appends this closer while resuming a log whose turn never
            // ended. Without a row the transcript would simply stop mid-turn.
            blocks.push({ kind: 'notice', tone: 'warning', text: 'Turn interrupted before it finished', seq })
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
  }

  const reduce = (): TranscriptReduction => {
    const visible: TranscriptBlock[] = []
    const visibleSources: number[] = []
    for (let index = 0; index < blocks.length; index += 1) {
      const block = assistants.get(index)?.project() ?? blocks[index]!
      // A pruned tool row only repeats the prune notice.
      if (block.kind === 'tool' && block.pruned === true) continue
      if (block.kind === 'assistant' && block.text === '' && (block.reasoning ?? '') === ''
        && block.starting !== true) continue
      visible.push(block)
      visibleSources.push(sources[index] ?? 0)
    }
    return trimTranscriptWindow(visible, visibleSources, options.maxEntries)
  }
  return { append, reduce }
}
