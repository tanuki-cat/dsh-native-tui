/**
 * Stream frame pacing and paint decisions.
 *
 * The transcript frame loop shares one event loop with the reader that turns
 * model bytes into events. Every millisecond a frame occupies the loop is a
 * millisecond the next chunk waits, and a delayed chunk stretches the decode
 * window the tok/s figure is measured over. These helpers keep that share
 * bounded while still letting a cheap window paint at the streaming floor.
 *
 * @module dsh-native-tui/ui/stream-pacing
 */

/** Streaming frame interval bounds, in milliseconds. */
export const STREAM_MIN_INTERVAL_MS = 33
/**
 * Share of the loop a streaming frame may occupy.
 *
 * The frame loop and the model-stream reader share one event loop, so a frame
 * that keeps the loop busy for longer than this share delays the next read, and
 * a delayed read is a delayed chunk — which is what stretches the decode window
 * the tok/s figure is measured over. Holding the interval to a multiple of the
 * measured cost (1 / share) keeps that window honest.
 */
const STREAM_FRAME_BUDGET_SHARE = 0.5
/**
 * Ceiling for the paint-bound interval.
 *
 * Pacing is a fraction of the loop, so an expensive paint stretches the interval
 * past the streaming floor instead of painting back to back. The ceiling keeps
 * a pathological window from stalling the stream outright.
 */
export const STREAM_PAINT_CEILING_MS = 500
/**
 * Minimum grace after an assistant block's last content before the rows that
 * follow it are shown.
 *
 * A shorter grace would let the final thinking text and the tool card that
 * follows it land on the same frame, which reads as the thinking ending and
 * the card appearing at once.
 */
export const STREAM_SETTLE_MIN_MS = 150

/**
 * Settle grace for the frame interval in effect.
 *
 * The grace has to outlast the gap between an assistant block's last content
 * and its first paint, or that paint shows the content and the following tool
 * card together — the exact frame the grace exists to prevent. The gap is the
 * frame interval, which now reaches {@link STREAM_PAINT_CEILING_MS}, so a grace
 * derived from a fixed interval no longer covers a backed-off window.
 * @param interval - interval the next frames are paced at.
 * @returns grace in milliseconds for that cadence.
 */
export function settleGraceMs(interval: number): number {
  const paced = Number.isFinite(interval) ? Math.max(0, interval) : 0
  return Math.max(STREAM_SETTLE_MIN_MS, Math.round(paced) + 50)
}

/**
 * Next streaming frame interval for one measured frame.
 *
 * The interval is the time that keeps a frame within
 * {@link STREAM_FRAME_BUDGET_SHARE} of the loop, so the reader that turns model
 * bytes into events always gets the rest. That is the whole point: the same
 * loop carries both, and a frame that overruns delays the chunk whose timestamp
 * the decode rate is measured from.
 *
 * The caller must pass the WHOLE frame cost — the rebuild plus the pi-tui paint
 * it triggers — because the paint is what the terminal actually pays, and it
 * grows with the retained transcript rather than with the live block. A cheap
 * frame still narrows toward {@link STREAM_MIN_INTERVAL_MS} one step at a time,
 * so the interval tracks a window that is growing or shrinking.
 * @param current - the interval the measured frame used.
 * @param frameMs - measured cost of that frame, rebuild and paint together.
 * @returns the interval to use for the next stream frame.
 */
export function nextStreamInterval(current: number, frameMs: number): number {
  const wanted = Math.max(STREAM_MIN_INTERVAL_MS, frameMs / STREAM_FRAME_BUDGET_SHARE)
  // Back off at once, recover slowly. A frame that just cost 200 ms must not be
  // followed by another immediately, so the interval jumps to what that cost
  // requires; a frame that comes back cheap only earns a quarter of the way
  // toward the floor, so one lucky frame inside a heavy window cannot flood the
  // loop again.
  const stepped = wanted > current ? wanted : Math.max(wanted, current * 0.75)
  return Math.max(STREAM_MIN_INTERVAL_MS, Math.min(STREAM_PAINT_CEILING_MS, Math.round(stepped)))
}

/**
 * How far a frame slipped past the moment it was due.
 *
 * The transcript component times only its own subtree; pi-tui's own line work —
 * cursor resolution, line resets, the differential write — happens after that,
 * grows with the rows on screen, and holds the same event loop the model stream
 * is read on. Measuring the slip captures all of it, so pacing can back off on
 * what the terminal actually cost even when no single component is slow.
 *
 * The slip also covers work that has nothing to do with the paint, so
 * {@link frameCostMs} caps it before it reaches the pacer.
 * @param dueAt - when the frame was scheduled to run, or undefined when it was
 *   triggered directly (a burst, a reveal, or the first frame).
 * @param now - the current wall clock.
 * @returns slipped milliseconds, or 0 for an on-time or unscheduled frame.
 */
export function frameOverrunMs(dueAt: number | undefined, now: number): number {
  if (dueAt === undefined || !Number.isFinite(dueAt) || !Number.isFinite(now)) return 0
  return Math.max(0, now - dueAt)
}

/**
 * Cost of one frame to pace the next interval against.
 *
 * The rebuild is measured directly. The paint and pi-tui's line work are only
 * visible as the next frame's lateness, which also contains unrelated loop work
 * — stream parsing, GC, an approval dialog, OS scheduling — so the slip is
 * capped at the interval the measured frame ran on. One stall can therefore
 * only double the interval once; a genuinely expensive frame still doubles it
 * on every frame until twice its cost fits, because each frame's slip is then
 * compared against the larger interval.
 * @param rebuildMs - measured rebuild and reduction time.
 * @param slipMs - milliseconds the frame started after it was due.
 * @param interval - interval the measured frame was scheduled on.
 * @returns cost in milliseconds, never negative or non-finite.
 */
export function frameCostMs(rebuildMs: number, slipMs: number, interval: number): number {
  const rebuild = Number.isFinite(rebuildMs) ? Math.max(0, rebuildMs) : 0
  const rawSlip = Number.isFinite(slipMs) ? Math.max(0, slipMs) : 0
  const cap = Number.isFinite(interval) && interval > 0 ? interval : Number.POSITIVE_INFINITY
  return rebuild + Math.min(rawSlip, cap)
}

/**
 * Delay before the next streaming frame.
 *
 * The delay is measured from the previous paint, not from the chunk that
 * requested it. Chunk arrivals are bursty, so re-arming a full interval on
 * every arrival makes frames alternate between one and two intervals — a
 * rhythm that reads as stutter even when each frame is cheap.
 * @param interval - the current adaptive frame interval.
 * @param elapsedSincePaint - milliseconds since the last painted frame.
 * @returns milliseconds to wait before painting.
 */
export function nextFrameDelay(interval: number, elapsedSincePaint: number): number {
  return Math.max(0, interval - Math.max(0, elapsedSincePaint))
}

/** What the last painted frame showed, for skipping identical repaints. */
export interface TranscriptPaintMark {
  /** Revision of the rows the rebuild produced, bumped when they change. */
  readonly revision: number
  /** The wait row text that frame drew, empty when it drew none. */
  readonly wait: string
}

/**
 * Whether a rebuild has anything new to paint.
 *
 * Frames are scheduled on a cadence, so some rebuild the same rows as the last
 * one. Repainting an identical screen only costs terminal writes; a local
 * reveal is the one case with no incoming data that still needs frames.
 * @param painted - state the last painted frame reflected.
 * @param current - state the rebuild just produced.
 * @param revealing - whether a completed reasoning block is still expanding.
 * @returns true when the frame must be painted.
 */
export function transcriptFrameChanged(
  painted: TranscriptPaintMark,
  current: TranscriptPaintMark,
  revealing: boolean,
): boolean {
  return revealing || current.revision !== painted.revision || current.wait !== painted.wait
}
