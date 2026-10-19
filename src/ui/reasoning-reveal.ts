/**
 * Local reveal of a completed reasoning block that arrived without deltas.
 *
 * Responses-compatible gateways can send the whole reasoning item in the
 * terminal `block-end`. The terminal reveals that text over frames so the
 * thinking area does not pop in as one block while the rest of the step is
 * still streaming.
 *
 * @module dsh-native-tui/ui/reasoning-reveal
 */

import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'

/** Maximum graphemes retained in one reasoning preview. */
export const REASONING_PREVIEW = 3000

/** Reveal rate for a completed reasoning block, in graphemes per millisecond. */
const REASONING_REVEAL_GRAPHEMES_PER_MS = 4
/** Upper bound on one local reasoning reveal, so later rows are not held too long. */
const REASONING_REVEAL_MAX_MS = 600
/** Maximum graphemes one render may add, so a delayed frame does not jump. */
const REASONING_REVEAL_MAX_STEP = 160
/** A durable settlement this recent may still be a live reveal without its live entry. */
export const REASONING_REVEAL_RECENT_MS = 1_000
/** Shared grapheme segmenter for reveal cuts and preview clipping. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Process-local progress of one completed-reasoning reveal. */
export interface RevealProgress {
  /** Wall clock at the first reveal render. */
  start: number
  /** Graphemes already shown. */
  visible: number
}

function graphemeCount(text: string): number {
  let count = 0
  for (const _segment of graphemeSegmenter.segment(text)) count += 1
  return count
}

function graphemePrefix(text: string, limit: number): string {
  if (limit <= 0) return ''
  let prefix = ''
  let count = 0
  for (const segment of graphemeSegmenter.segment(text)) {
    if (count >= limit) break
    prefix += segment.segment
    count += 1
  }
  return prefix
}

/** Clip a reasoning preview at a grapheme boundary. */
export function clipGraphemes(text: string, limit: number): string {
  const total = graphemeCount(text)
  if (total <= limit) return text
  return graphemePrefix(text, limit) + `\n… [${String(total - limit)} chars omitted]`
}

/**
 * Reveal one completed reasoning block over frames. A tracked progress starts
 * at the first render and advances by at most {@link REASONING_REVEAL_MAX_STEP}
 * per call; an untracked direct reducer keeps the older elapsed-since-block-end
 * behavior.
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
  const total = graphemeCount(text)
  const displayTotal = Math.min(total, REASONING_PREVIEW)
  const rate = Math.max(REASONING_REVEAL_GRAPHEMES_PER_MS, displayTotal / REASONING_REVEAL_MAX_MS)
  const start = progress?.start ?? fallbackStart ?? now
  const elapsed = Math.max(0, now - start)
  const target = Math.min(displayTotal, Math.max(1, Math.floor(elapsed * rate)))
  const visible = progress === undefined
    ? target
    : Math.min(displayTotal, Math.max(progress.visible, Math.min(target, progress.visible + REASONING_REVEAL_MAX_STEP)))
  if (progress !== undefined) progress.visible = visible
  if (visible >= displayTotal) return { text, pending: false }
  return { text: graphemePrefix(text, visible), pending: true }
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
 * @param showReasoning - false when the thinking display is hidden.
 * @param progress - tracked live reveal, when one exists.
 * @param tracked - true when the caller supplies a reveal-progress map.
 * @returns the visible prefix and whether more remains.
 */
export function revealDurableReasoning(
  text: string,
  from: number | undefined,
  now: number,
  showReasoning: boolean,
  progress: RevealProgress | undefined,
  tracked: boolean,
): { readonly text: string; readonly pending: boolean } {
  if (!showReasoning || text.trim() === '') return { text, pending: false }
  if (from === undefined) return { text, pending: false }
  if (tracked) {
    if (progress === undefined) return { text, pending: false }
    return revealCompletedReasoning(text, now, progress)
  }
  return revealCompletedReasoning(text, now, undefined, from)
}
