/**
 * Bounded interactive stream reveal and grapheme-safe preview clipping.
 * Stateless reducers retain timestamp-based completed reasoning previews.
 * @module dsh-native-tui/ui/reasoning-reveal
 */

import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { debug } from '../debug.js'

/** Reveal rate for a completed reasoning block, in graphemes per millisecond. */
const REASONING_REVEAL_GRAPHEMES_PER_MS = 4
/**
 * Wall-clock budget for untracked, stateless reasoning previews.
 * Interactive rendering uses the per-frame budget instead.
 */
export const REASONING_REVEAL_MAX_MS = 600
/** Tracked reveal entries retained before the oldest is dropped. */
const REVEAL_PROGRESS_LIMIT = 64
/** Completed reasoning texts whose grapheme boundaries stay cached. */
const GRAPHEME_CACHE_LIMIT = 8

/** Shared grapheme segmenter for reveal cuts and preview clipping. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Process-local progress of one interactive content part. */
export interface RevealProgress {
  /** Wall clock of the last advance, used for diagnostics. */
  start: number
  /** UTF-16 offset already shown. */
  visible: number
  /** Last visible prefix update; survives live-to-durable event-window replacement. */
  paintedAt?: number
  /**
   * Characters per frame for the answer burst being revealed. Absent once the
   * burst is drained, so the next chunk is planned on its own.
   */
  step?: number
  /** A trailing high surrogate was held for one frame awaiting its low half. */
  dangling?: boolean
}

/** Process-local grapheme cache for one reasoning text. */
interface GraphemeEntry {
  /** Total graphemes, counted on first use. */
  count?: number
  /** Grapheme strings built so far, in order. */
  readonly segments: string[]
  iterator?: Iterator<Intl.SegmentData>
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
  entry.iterator ??= graphemeSegmenter.segment(text)[Symbol.iterator]()
  while (segments.length < limit) {
    const next = entry.iterator.next()
    if (next.done) break
    segments.push(next.value.segment)
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

/** Forget only the settled attempt's part offsets; another step keeps its progress. */
export function forgetStepReveal(map: Map<string, RevealProgress> | undefined, key: string): void {
  for (const progressKey of map?.keys() ?? []) {
    if (['reasoning:', 'text:'].some(prefix => progressKey === prefix + key || progressKey.startsWith(prefix + key + ':part:'))) map?.delete(progressKey)
  }
}

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
  // A token-sized delta is already the provider's own granularity.
  if (progress.step === undefined && backlog <= STREAM_TEXT_INSTANT_BACKLOG) {
    progress.step = backlog
    progress.start = now
  }
  else if (progress.step === undefined) {
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
  // Keep combining marks and emoji sequences with the base grapheme.
  if (next < total) {
    const suffix = text.slice(progress.visible)
    let boundary = progress.visible
    for (const segment of graphemeSegmenter.segment(suffix)) {
      const end = progress.visible + segment.index + segment.segment.length
      if (end > next && boundary > progress.visible) break
      boundary = end
      if (end >= next) break
    }
    next = boundary
  }
  // Never cut a surrogate pair: a lone half renders as a replacement glyph.
  if (next < total && isHighSurrogate(text.charCodeAt(next - 1))) next += 1
  // Wait one frame for a split surrogate, but let malformed settled input drain.
  const dangling = next === total && isHighSurrogate(text.charCodeAt(total - 1)) && !progress.dangling
  if (dangling) next = total - 1
  progress.dangling = dangling
  progress.visible = next
  progress.start = now
  const pending = next < total
  if (!pending) progress.step = undefined
  debug(`reveal text: backlog=${String(backlog)} advance=${String(advance)} step=${String(progress.step ?? 0)} visible=${String(next)}/${String(total)} elapsed=${String(Math.round(elapsed))}ms pending=${String(pending)}`)
  return pending ? { text: text.slice(0, next), pending: true } : { text, pending: false }
}

/**
 * Project a completed reasoning preview for a stateless reducer.
 * @param text - completed reasoning text.
 * @param now - current wall clock.
 * @param from - block-end timestamp.
 * @returns the visible prefix and whether more remains.
 */
export function revealCompletedReasoning(
  text: string,
  now: number,
  from: number,
): { readonly text: string; readonly pending: boolean } {
  if (text === '') return { text: '', pending: false }
  const entry = entryFor(text)
  const total = graphemeCount(text, entry)
  const rate = Math.max(REASONING_REVEAL_GRAPHEMES_PER_MS, total / REASONING_REVEAL_MAX_MS)
  const elapsed = Math.max(0, now - from)
  const visible = Math.min(total, Math.max(1, Math.floor(elapsed * rate)))
  if (visible >= total) return { text, pending: false }
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
