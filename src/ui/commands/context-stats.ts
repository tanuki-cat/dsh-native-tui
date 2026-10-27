/**
 * `/context`: what the next request costs and what that context is made of.
 *
 * The status row shows only the occupancy percentage. This command prints the
 * figures behind it plus the Web context panel's composition breakdown.
 *
 * The two halves are measured differently, and the report says so rather than
 * inviting an addition: occupancy is anchored to the provider's own prompt
 * count, while the composition is the token meter's fixed-estimator view of the
 * same surface. Measured on a real session that estimator prices the surface
 * about 1.4x higher, because it charges every tool result and every CJK
 * character at a flat rate where the provider's tokenizer does not. Printing the
 * estimator's total as a second "context size" made the two figures read as a
 * counting bug, so the legend states proportions, and the estimator's own total
 * appears only in the note that explains the gap.
 *
 * @module dsh-native-tui/ui/commands/context-stats
 */

import {
  contextComposition,
  formatSharePercent,
  formatTokenCount,
  type ContextBreakdown,
  type SessionMetrics,
} from '../../runtime/metrics.js'
import type { Palette } from '../theme.js'
import type { CommandContext } from './context.js'
import { NL } from './shared.js'

/** Width of the label column in the composition legend, in cells; the labels are ASCII. */
const LEGEND_LABEL_WIDTH = 19

/** Width of the shares column, so the percentages line up under each other. */
const LEGEND_SHARE_WIDTH = 7

/** Width of the trailing amount column, which keeps every row the same length. */
const LEGEND_AMOUNT_WIDTH = 8

/**
 * Build the `/context` notice body.
 *
 * Kept apart from the handler so the wording is testable without a Host: every
 * branch is a different silence (no sample yet, no meter, empty surface), and
 * each one says which it is instead of printing zeros.
 * @param metrics - the same folded metrics the status row renders.
 * @param breakdown - token meter composition, or undefined when unmounted.
 * @param palette - colours; the composition rows use the Web meter's per-bucket hues.
 * @returns the notice body.
 */
export function contextReport(
  metrics: SessionMetrics,
  breakdown: ContextBreakdown | undefined,
  palette?: Palette,
): string {
  const lines: string[] = []
  const percent = metrics.contextPercent
  const estimate = metrics.contextEstimateTokens
  const window = metrics.contextWindowTokens
  if (percent === undefined) {
    lines.push('Context used: —')
    lines.push('Waiting for the first provider usage sample; the meter prices nothing before then.')
  }
  else {
    const figures = estimate === undefined || window === undefined
      ? ''
      : '  ·  ~' + formatTokenCount(estimate) + ' / ' + formatTokenCount(window)
    lines.push('Context used: ' + String(percent) + '%' + figures)
    if (metrics.contextCompactPercent !== undefined)
      lines.push('Automatic compaction: at ' + String(metrics.contextCompactPercent) + '% of the window')
  }
  if (breakdown === undefined) {
    lines.push('', 'Composition: unknown (the token meter is not mounted).')
    return lines.join(NL)
  }
  // The bar and each legend row take the Web meter's per-bucket hue, so the
  // pairing survives without relying on the row order. A palette without the
  // role — an older build, or a test stub — degrades to uncoloured text rather
  // than failing a command run over a decoration.
  const tint = (bucket: 'system' | 'tools' | 'messages'): ((text: string) => string) =>
    typeof palette?.contextBucket === 'function' ? palette.contextBucket(bucket) : (text: string) => text
  const composition = contextComposition(breakdown, percent ?? 0, tint)
  if (composition.rows.length === 0) {
    lines.push('', 'Composition: the surface is still empty.')
    return lines.join(NL)
  }
  lines.push('', composition.bar)
  for (const row of composition.rows) {
    // Every column is padded to a fixed width rather than separated by a fixed
    // gap, so a label of exactly the column's width cannot collapse the gutter
    // and shift its row's figures out of line with the others. Padding happens
    // before colouring; ANSI bytes would otherwise count as printable cells.
    const label = (row.glyph + ' ' + row.label).padEnd(LEGEND_LABEL_WIDTH)
    const figures = formatSharePercent(row.tenths).padStart(LEGEND_SHARE_WIDTH)
      + ('~' + formatTokenCount(row.tokens)).padStart(LEGEND_AMOUNT_WIDTH + 2)
    const swatch = tint(row.bucket)(row.glyph)
    lines.push(swatch + label.slice(1) + figures)
  }
  const splitTotal = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  if (breakdown.rebuilt === 'out-of-scale') {
    // The buckets were rescaled onto the occupancy, so they add up to it; say so,
    // because the meter's raw figures would not have.
    lines.push('', 'Shares split the ' + String(percent) + '% above (~' + formatTokenCount(splitTotal)
      + ' tokens) in proportion to the meter\'s composition estimate. Reasoning the request does not '
      + 'replay is left out and the split is scaled to the provider\'s own count, so this reads as one '
      + 'context instead of two competing totals.')
  }
  return lines.join(NL)
}

/** The `/context` command. */
export function contextCommand(ctx: CommandContext): void {
  const { metrics, breakdown } = ctx.readContext()
  ctx.notice('info', contextReport(metrics, breakdown, ctx.palette))
}
