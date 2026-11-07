/**
 * Chrome rows written only when the text they would show changes.
 *
 * `Text.setText` drops its render cache for an identical string too, so a
 * caller that writes on every Session event turns a projection or agent-status
 * change into a full component-tree paint even when nothing visible moved.
 *
 * @module dsh-native-tui/ui/status-rows
 */

import type { StatusRows } from './status-line.js'

/** Deduplicated chrome rows plus the change flag one paint reads. */
export interface DedupedStatusRows {
  /** The rows to hand to `renderStatusRows`. */
  readonly rows: StatusRows
  /** Clear the change flag before one paint. */
  reset(): void
  /** True when the last paint wrote at least one row. */
  readonly changed: boolean
}

/**
 * Wrap the chrome rows so identical text is never written twice.
 * @param targets - the text components that own each row.
 * @returns the deduplicating rows and their per-paint change flag.
 */
export function createStatusRows(targets: StatusRows): DedupedStatusRows {
  const painted = new Map<keyof StatusRows, string>()
  let changed = false
  const row = (key: keyof StatusRows): { setText(text: string): void } => ({
    setText: (text: string): void => {
      if (painted.get(key) === text) return
      painted.set(key, text)
      changed = true
      targets[key].setText(text)
    },
  })
  return {
    rows: { header: row('header'), status: row('status'), footer: row('footer') },
    reset: () => { changed = false },
    get changed() { return changed },
  }
}
