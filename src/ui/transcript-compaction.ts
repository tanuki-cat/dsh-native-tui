/**
 * Cold-start compaction for the transcript reducer.
 *
 * A resumed Session can deliver tens of thousands of events in one window.
 * `reduce()` trims rows, but only after every event has materialized a block.
 * Once the block list grows far past the retained row budget, the oldest final
 * blocks cannot reappear, so the reducer drops them in place.
 *
 * @module dsh-native-tui/ui/transcript-compaction
 */

import type { TranscriptBlock } from './transcript.js'

/** Blocks past the row budget that trigger one cold-start compaction. */
export const COMPACT_SLACK = 256

/**
 * Blocks past the row budget kept after compaction.
 *
 * Keeping a trim batch above the budget preserves the static "earlier entries
 * hidden" notice the window would have emitted for the same history.
 */
export const COMPACT_RETAIN = 64

/**
 * Whether a block can no longer change.
 *
 * Pending tool calls, live assistant rows and running compactions may still be
 * updated by a later event, so they must stay addressable.
 * @param block - one reduced block.
 * @returns true when no future event can rewrite it.
 */
export function isFinalTranscriptBlock(block: TranscriptBlock): boolean {
  switch (block.kind) {
    case 'tool': return block.pending === false
    case 'assistant': return block.live === false
    case 'compaction': return block.state !== 'running'
    default: return true
  }
}

/**
 * Drop the oldest prefix of final blocks once the reducer is far past budget.
 *
 * Only a contiguous prefix is removed: a pending block in front of a settled
 * one keeps the array intact until it settles, so every removed index is final
 * and every retained block keeps its order relative to the entries it needs.
 * @param blocks - reducer blocks, oldest first.
 * @param sources - entry index that created each block, parallel to `blocks`.
 * @param finalPrefix - count of leading blocks known to be final.
 * @param maxEntries - retained transcript row budget.
 * @returns how many blocks were removed from the front.
 */
export function compactTranscriptBlocks(
  blocks: TranscriptBlock[],
  sources: number[],
  finalPrefix: number,
  maxEntries: number,
): number {
  if (blocks.length <= maxEntries + COMPACT_SLACK) return 0
  const target = Math.max(0, maxEntries + COMPACT_RETAIN)
  const drop = Math.min(finalPrefix, blocks.length - target)
  if (drop <= 0) return 0
  blocks.splice(0, drop)
  sources.splice(0, drop)
  return drop
}
