/**
 * Retained-window trimming for the transcript reducer.
 *
 * main-screen pi-tui can only patch rows inside the viewport: a change above it
 * clears the screen and rewrites the whole transcript. A saturated window that
 * drops one row per arriving block would therefore repaint on every block, so
 * trimming waits for a whole batch and advertises the drop with a static notice.
 *
 * @module dsh-native-tui/ui/transcript-window
 */

import type { TranscriptBlock } from './transcript.js'

/**
 * Rows dropped per saturated-window trim.
 *
 * The window waits until a whole batch of rows has overflowed, then drops them
 * at once: one full repaint per batch instead of one per arriving block.
 */
const TRIM_BATCH = 50

/**
 * Oldest entry any retained row still needs.
 *
 * Rows are appended in entry order, but a row keeps the entry that created it
 * even when a later event updates it (a `tool/result` settles the card its
 * `tool/call` created). Taking the minimum over every retained row means the
 * boundary never drops an entry that a later retained row still names.
 * @param sources - entry index that created each row, oldest first.
 * @param from - index of the first retained row.
 * @returns the oldest entry index a retained row still needs.
 */
function oldestSource(sources: readonly number[], from: number): number {
  let oldest = sources[from] ?? 0
  for (let index = from + 1; index < sources.length; index += 1) {
    const source = sources[index]!
    if (source < oldest) oldest = source
  }
  return oldest
}

/**
 * Trim a reduced transcript window to its retained-row budget.
 *
 * Within the budget the input rows are returned as-is, so a normal frame pays
 * only the length check. Past it, the overflow is dropped in one batch with a
 * count-free notice at the top; a notice whose number changed every frame would
 * rewrite the first row and repaint the transcript on every arrival.
 * @param visible - rows the reducer decided to show, oldest first.
 * @param sources - entry index that created each row, parallel to `visible`.
 * @param maxEntries - retained row budget.
 * @returns the retained rows and the oldest entry a retained row still needs.
 */
export function trimTranscriptWindow(
  visible: TranscriptBlock[],
  sources: readonly number[],
  maxEntries: number,
): { readonly blocks: TranscriptBlock[]; readonly retainedFrom: number } {
  if (visible.length <= maxEntries) {
    return { blocks: visible, retainedFrom: oldestSource(sources, 0) }
  }
  const overflow = visible.length - maxEntries
  // A small cap (an explicit setting) trims exactly at its bound: waiting for a
  // whole batch there would let the window grow far past what was asked for.
  const batched = maxEntries >= TRIM_BATCH
  const hidden = batched && overflow < TRIM_BATCH ? 0 : overflow
  const trimmed: TranscriptBlock[] = []
  if (hidden > 0) trimmed.push({ kind: 'notice', tone: 'info', text: '… earlier transcript entries hidden …' })
  trimmed.push(...visible.slice(hidden))
  return { blocks: trimmed, retainedFrom: oldestSource(sources, hidden) }
}
