import { Text, type Component } from '@earendil-works/pi-tui'
import type { ContextBreakdown, SessionMetrics } from '../runtime/metrics.js'
import { contextReport } from './commands/context-stats.js'
import type { Palette } from './theme.js'

/** Command-time figures, kept separate from the plain notice fallback. */
export interface ContextReportData {
  readonly metrics: SessionMetrics
  readonly breakdown: ContextBreakdown | undefined
}

/** Generate only UI-owned styling from the report's structured figures. */
export class ContextReportMessage implements Component {
  constructor(private readonly report: ContextReportData, private readonly palette: Palette) {}

  render(width: number): string[] {
    const text = contextReport(this.report.metrics, this.report.breakdown, this.palette).replaceAll('\n', '\n  ')
    return new Text(this.palette.dim('i ') + text, 0, 0).render(width)
  }

  invalidate(): void {}
}
