/** One file declared by the present tool. */
export interface PresentedFileView {
  readonly path: string
  readonly description?: string
}

/** One deliverables/presented session event projection. */
export interface PresentedEventView {
  readonly turn: number
  readonly files: readonly PresentedFileView[]
}

/** One de-duplicated presented file with its latest declaring turn. */
export interface CollectedDeliverable {
  readonly path: string
  readonly description?: string
  readonly turn: number
}

/**
 * Collect presented files, keeping the latest declaration for each path.
 * @param events - presented events in session order.
 * @returns unique files in first-declaration order.
 */
export function collectDeliverables(events: readonly PresentedEventView[]): CollectedDeliverable[] {
  const byPath = new Map<string, CollectedDeliverable>()
  for (const event of events) {
    for (const file of event.files) {
      byPath.set(file.path, {
        path: file.path,
        ...(file.description === undefined ? {} : { description: file.description }),
        turn: event.turn,
      })
    }
  }
  return [...byPath.values()]
}

/**
 * Format durable presented files, de-duplicated by path with the latest declaration winning.
 * @param events - presented events in session order.
 * @param maxFiles - maximum rows shown.
 * @returns compact multi-line list.
 */
export function formatDeliverables(events: readonly PresentedEventView[], maxFiles = 50): string {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error('deliverables maxFiles must be a positive safe integer')
  const rows = collectDeliverables(events)
  if (rows.length === 0) return 'No presented deliverables.'
  const lines = ['Deliverables · ' + String(rows.length) + ' file(s)']
  for (const [index, row] of rows.slice(0, maxFiles).entries()) {
    lines.push(String(index) + '. ' + row.path
      + (row.description === undefined || row.description === '' ? '' : ' — ' + row.description)
      + '  (turn ' + String(row.turn) + ')')
  }
  if (rows.length > maxFiles) lines.push('… ' + String(rows.length - maxFiles) + ' more file(s)')
  return lines.join('\n')
}