/**
 * Chrome rows written only when their content or layout metadata changes.
 *
 * @module dsh-native-tui/ui/status-rows
 */

import type { StatusRows } from './status-line.js'
import type { StatusBarTarget, StatusSegment } from './status-bar.js'

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
  let header: string | undefined
  const painted = new Map<'status' | 'footer', readonly StatusSegment[]>()
  let changed = false
  const row = (key: 'status' | 'footer'): StatusBarTarget => ({
    setSegments: (segments): void => {
      const previous = painted.get(key)
      if (previous !== undefined && previous.length === segments.length && previous.every((segment, index) => {
        const next = segments[index]
        return next !== undefined && segment.text === next.text
          && segment.compact === next.compact && segment.priority === next.priority
      })) return
      painted.set(key, segments)
      changed = true
      targets[key].setSegments(segments)
    },
  })
  return {
    rows: {
      header: { setText: text => {
        if (header === text) return
        header = text
        changed = true
        targets.header.setText(text)
      } },
      status: row('status'),
      footer: row('footer'),
    },
    reset: () => { changed = false },
    get changed() { return changed },
  }
}
