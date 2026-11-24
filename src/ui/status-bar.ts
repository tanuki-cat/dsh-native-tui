import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'

function truncate(text: string, width: number): string {
  const result = truncateToWidth(text, width, '…')
  return text.includes('\u001B') ? result : stripTerminalSequences(result)
}

/** One status field; larger priorities are hidden first when space runs out. */
export interface StatusSegment {
  readonly text: string
  readonly compact?: string
  readonly priority?: number
}

export interface StatusBarTarget {
  setSegments(segments: readonly StatusSegment[]): void
}

/** A fixed-height status row that reflows its fields on every terminal resize. */
export class StatusBar implements Component, StatusBarTarget {
  private segments: readonly StatusSegment[] = []
  private lastWidth = -1
  private lastSep: string | undefined
  private cachedLines: string[] | undefined

  constructor(private readonly separator: string | (() => string)) {}

  setSegments(segments: readonly StatusSegment[]): void {
    this.segments = segments
    this.cachedLines = undefined
  }

  invalidate(): void {
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    const sep = typeof this.separator === 'function' ? this.separator() : this.separator
    if (this.cachedLines !== undefined && this.lastWidth === width && this.lastSep === sep) {
      return this.cachedLines
    }
    if (width <= 0) {
      this.lastWidth = width
      this.lastSep = sep
      this.cachedLines = ['']
      return this.cachedLines
    }
    const fields = this.segments.filter(segment => visibleWidth(segment.text) > 0).map(segment => ({ ...segment }))
    const join = (): string => fields.map(field => field.text).join(sep)
    const order = [...fields].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    for (const field of order) {
      if (visibleWidth(join()) <= width) break
      if (field.compact !== undefined) field.text = field.compact
    }
    for (const field of order) {
      if (visibleWidth(join()) <= width) break
      if ((field.priority ?? 0) > 0) fields.splice(fields.indexOf(field), 1)
    }
    // A long model or permission label must not push the other essential fields
    // off screen. Shorten the widest field before the final tiny-window clamp.
    while (visibleWidth(join()) > width && fields.length > 0) {
      const widest = fields.reduce((left, right) => visibleWidth(left.text) >= visibleWidth(right.text) ? left : right)
      const available = visibleWidth(widest.text) - (visibleWidth(join()) - width)
      if (available < 1) break
      widest.text = truncate(widest.text, available)
    }
    this.lastWidth = width
    this.lastSep = sep
    this.cachedLines = [truncate(join(), width)]
    return this.cachedLines
  }
}
