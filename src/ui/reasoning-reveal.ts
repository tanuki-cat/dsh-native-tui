/**
 * Local reveal of a completed reasoning block that arrived without deltas.
 *
 * Responses-compatible gateways can send the whole reasoning item in the
 * terminal `block-end`. The terminal reveals that text over frames so the
 * thinking area does not pop in as one block while the rest of the step is
 * still streaming.
 *
 * The reveal is paced by wall clock, not by frame count: a slow frame skips
 * ahead instead of stretching the animation, so one block never holds later
 * rows for longer than {@link REASONING_REVEAL_MAX_MS}.
 *
 * @module dsh-native-tui/ui/reasoning-reveal
 */

import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { debug } from '../debug.js'

/** Maximum graphemes retained in one reasoning preview. */
export const REASONING_PREVIEW = 3000

/** Reveal rate for a completed reasoning block, in graphemes per millisecond. */
const REASONING_REVEAL_GRAPHEMES_PER_MS = 4
/**
 * Wall-clock budget for one local reasoning reveal. The reveal rate is raised
 * when needed so the whole preview finishes inside this budget, and it keeps
 * finishing on time when frames are slow.
 */
export const REASONING_REVEAL_MAX_MS = 600
/** A durable settlement this recent may still be a live reveal without its live entry. */
export const REASONING_REVEAL_RECENT_MS = 1_000
/** Tracked reveal entries retained before the oldest is dropped. */
const REVEAL_PROGRESS_LIMIT = 64
/** Completed reasoning texts whose grapheme boundaries stay cached. */
const GRAPHEME_CACHE_LIMIT = 8

/** Shared grapheme segmenter for reveal cuts and preview clipping. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Process-local progress of one completed-reasoning reveal. */
export interface RevealProgress {
  /** Wall clock of the first frame of the burst being revealed. */
  start: number
  /** Graphemes already shown. */
  visible: number
  /**
   * Characters per frame for the answer burst being revealed. Absent once the
   * burst is drained, so the next chunk is planned on its own.
   */
  step?: number
}

/** Process-local grapheme cache for one reasoning text. */
interface GraphemeEntry {
  /** Total graphemes, counted on first use. */
  count?: number
  /** Grapheme strings built so far, in order. */
  readonly segments: string[]
}

/**
 * Reasoning texts keyed by value. A single block is reduced and rendered every
 * stream frame, so segmenting its text once turns that cost into a constant.
 */
const graphemeCache = new Map<string, GraphemeEntry>()

function entryFor(text: string): GraphemeEntry {
  const cached = graphemeCache.get(text)
  if (cached !== undefined) {
    // Refresh insertion order so the cache drops the coldest text first.
    graphemeCache.delete(text)
    graphemeCache.set(text, cached)
    return cached
  }
  const entry: GraphemeEntry = { segments: [] }
  graphemeCache.set(text, entry)
  if (graphemeCache.size > GRAPHEME_CACHE_LIMIT) {
    const oldest = graphemeCache.keys().next().value
    if (oldest !== undefined) graphemeCache.delete(oldest)
  }
  return entry
}

function graphemeCount(text: string, entry: GraphemeEntry): number {
  if (entry.count !== undefined) return entry.count
  let count = 0
  for (const _segment of graphemeSegmenter.segment(text)) count += 1
  entry.count = count
  return count
}

function graphemePrefix(text: string, limit: number, entry: GraphemeEntry): string {
  if (limit <= 0) return ''
  const segments = entry.segments
  if (segments.length < limit) {
    for (const segment of graphemeSegmenter.segment(text)) {
      if (segments.length >= limit) break
      segments.push(segment.segment)
    }
  }
  return segments.length <= limit ? segments.join('') : segments.slice(0, limit).join('')
}

/** Clip a reasoning preview at a grapheme boundary. */
export function clipGraphemes(text: string, limit: number): string {
  const entry = entryFor(text)
  const total = graphemeCount(text, entry)
  if (total <= limit) return text
  return graphemePrefix(text, limit, entry) + `\n… [${String(total - limit)} chars omitted]`
}

/**
 * Record one tracked reveal, dropping the oldest step once the map is full.
 * @param map - per-step reveal progress.
 * @param key - reveal identity, normally `reasoning:<turn>:<step>`.
 * @param progress - progress to record.
 */
export function rememberRevealProgress(
  map: Map<string, RevealProgress>,
  key: string,
  progress: RevealProgress,
): void {
  map.set(key, progress)
  while (map.size > REVEAL_PROGRESS_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

/** Prefix of an answer-text reveal, so retries and reasoning keys cannot collide. */
export const STREAM_TEXT_PROGRESS_PREFIX = 'text:'

/** Prefix of a live reasoning-delta reveal. */
export const REASONING_LIVE_PROGRESS_PREFIX = 'reasoning-live:'

/**
 * Largest unread answer backlog still spread over frames. A burst bigger than
 * this is a non-streaming gateway sending a whole block at once; delaying that
 * behind an animation would only make the UI lag the model.
 */
export const STREAM_TEXT_MAX_BACKLOG = 600

/**
 * Frames one burst is spread over. The step is planned once per burst instead
 * of taking a share of what is left every frame: a share shrinks with the
 * backlog and ends in a long tail of one-character frames.
 */
export const STREAM_TEXT_REVEAL_FRAMES = 6

/** Largest advance of one reveal frame, in characters. */
export const STREAM_TEXT_MAX_STEP = 24

/**
 * Backlog small enough to paint with its chunk. A provider delta of this size
 * is already the model's own granularity; splitting it would only add latency.
 */
export const STREAM_TEXT_INSTANT_BACKLOG = 12

/** Whether one UTF-16 unit opens a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

/**
 * Spread streamed answer text over frames instead of painting a whole provider
 * chunk at once.
 *
 * Providers hand text over in bursts: one event can carry a whole sentence, so
 * painting each batch makes the answer appear in jumps. A burst is planned once
 * and then revealed at a constant step, so the reader sees a flow instead of a
 * block.
 *
 * The step is a frame budget, not elapsed wall clock. Pacing by wall clock makes
 * the size of a paint depend on how long the previous frame happened to take,
 * and — because a chunk usually arrives after an idle gap — paints the whole
 * chunk at once. That is the block-shaped jump this exists to avoid.
 * @param text - all answer text received for the step so far.
 * @param progress - reveal state for this step; advanced in place.
 * @param now - current wall clock, used for diagnostics and the burst clock.
 * @returns the prefix to render and whether more text is still waiting.
 */
export function revealStreamText(
  text: string,
  progress: RevealProgress,
  now: number,
): { readonly text: string; readonly pending: boolean } {
  const total = text.length
  if (total === 0) return { text, pending: false }
  if (progress.visible >= total) {
    progress.visible = total
    progress.step = undefined
    progress.start = now
    return { text, pending: false }
  }
  const backlog = total - progress.visible
  // A whole-block settlement is not a stream: show it, do not animate it.
  if (backlog > STREAM_TEXT_MAX_BACKLOG) {
    progress.visible = total
    progress.step = undefined
    progress.start = now
    return { text, pending: false }
  }
  // A token-sized delta is already the provider's own granularity.
  if (progress.step === undefined && backlog <= STREAM_TEXT_INSTANT_BACKLOG) {
    progress.visible = total
    progress.start = now
    return { text, pending: false }
  }
  if (progress.step === undefined) {
    progress.step = Math.max(1, Math.min(STREAM_TEXT_MAX_STEP, Math.ceil(backlog / STREAM_TEXT_REVEAL_FRAMES)))
    // A new burst starts its own clock: the idle gap before it says nothing
    // about how fast this burst should be revealed.
    progress.start = now
  }
  else if (backlog > progress.step * STREAM_TEXT_REVEAL_FRAMES * 2) {
    // The burst outgrew the plan by more than a whole plan, so the model is
    // faster than the current step; widen it. Nothing here is paced by wall
    // clock: a slow terminal must not turn one frame into a block-shaped jump.
    progress.step = Math.max(1, Math.min(STREAM_TEXT_MAX_STEP, Math.ceil(backlog / STREAM_TEXT_REVEAL_FRAMES)))
  }
  const elapsed = Math.max(0, now - progress.start)
  const step = progress.step ?? 1
  const advance = Math.min(backlog, step)
  let next = progress.visible + advance
  // Never cut a surrogate pair: a lone half renders as a replacement glyph.
  if (next < total && isHighSurrogate(text.charCodeAt(next - 1))) next += 1
  // A chunk can end inside a pair. Hold that half-written pair until its low
  // half arrives, unless holding would stop the reveal from advancing.
  if (next === total && total - 1 > progress.visible && isHighSurrogate(text.charCodeAt(total - 1))) {
    next = total - 1
  }
  progress.visible = next
  progress.start = now
  const pending = next < total
  if (!pending) progress.step = undefined
  debug(`reveal text: backlog=${String(backlog)} advance=${String(advance)} step=${String(progress.step ?? 0)} visible=${String(next)}/${String(total)} elapsed=${String(Math.round(elapsed))}ms pending=${String(pending)}`)
  return pending ? { text: text.slice(0, next), pending: true } : { text, pending: false }
}

/**
 * Reveal one completed reasoning block over frames. The visible length follows
 * elapsed wall clock, so a slow frame catches up instead of stretching the
 * reveal; a tracked progress never moves backwards.
 * @param text - completed reasoning text.
 * @param now - current wall clock.
 * @param progress - tracked reveal state, or undefined for a direct reducer.
 * @param fallbackStart - block-end time used when no progress is tracked.
 * @returns the visible prefix and whether more remains.
 */
export function revealCompletedReasoning(
  text: string,
  now: number,
  progress?: RevealProgress,
  fallbackStart?: number,
): { readonly text: string; readonly pending: boolean } {
  if (text === '') return { text: '', pending: false }
  const entry = entryFor(text)
  const total = graphemeCount(text, entry)
  const displayTotal = Math.min(total, REASONING_PREVIEW)
  const rate = Math.max(REASONING_REVEAL_GRAPHEMES_PER_MS, displayTotal / REASONING_REVEAL_MAX_MS)
  const start = progress?.start ?? fallbackStart ?? now
  const elapsed = Math.max(0, now - start)
  const target = Math.min(displayTotal, Math.max(1, Math.floor(elapsed * rate)))
  const visible = progress === undefined
    ? target
    : Math.min(displayTotal, Math.max(progress.visible, target))
  if (progress !== undefined) progress.visible = visible
  if (visible >= displayTotal) return { text, pending: false }
  return { text: graphemePrefix(text, visible, entry), pending: true }
}

/**
 * Start time of a completed reasoning block in one durable compact stream.
 * A stream with reasoning-chunks was already rendered as deltas, so it keeps
 * the plain full-text path.
 * @param stream - compact records from an assistant settlement.
 * @returns the block-end timestamp to reveal from, or undefined.
 */
export function reasoningRevealFrom(stream: readonly AssistantStreamRecord[] | undefined): number | undefined {
  if (!Array.isArray(stream)) return undefined
  let sawDeltas = false
  let completedAt: number | undefined
  for (const record of stream) {
    if (record.type === 'reasoning-chunks') sawDeltas = true
    else if (record.type === 'chunk'
      && record.chunk.type === 'block-end'
      && record.chunk.block.type === 'reasoning'
      && completedAt === undefined) {
      completedAt = record.time
    }
  }
  return sawDeltas ? undefined : completedAt
}

/**
 * Reveal a completed reasoning block carried by a durable settlement.
 * @param text - full reasoning text from the message content.
 * @param from - block-end timestamp, or undefined when deltas already streamed.
 * @param now - current wall clock.
 * @param reveal - false when the thinking display does not show the full block.
 * @param progress - tracked live reveal, when one exists.
 * @param tracked - true when the caller supplies a reveal-progress map.
 * @returns the visible prefix and whether more remains.
 */
export function revealDurableReasoning(
  text: string,
  from: number | undefined,
  now: number,
  reveal: boolean,
  progress: RevealProgress | undefined,
  tracked: boolean,
): { readonly text: string; readonly pending: boolean } {
  if (!reveal || text.trim() === '') return { text, pending: false }
  if (from === undefined) return { text, pending: false }
  if (tracked) {
    if (progress === undefined) return { text, pending: false }
    return revealCompletedReasoning(text, now, progress)
  }
  return revealCompletedReasoning(text, now, undefined, from)
}
