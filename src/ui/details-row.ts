import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'

/** One shared footer for every expandable transcript card. */
export function detailsRow(palette: Palette, expanded: boolean, width: number): string {
  const inset = ' '.repeat(Math.min(2, Math.max(0, width - 1)))
  const row = truncateToWidth(palette.dim(inset + (expanded ? 'Hide details' : 'Show details') + ' · ctrl+o'), Math.max(0, width), '…')
  return palette.plain ? stripTerminalSequences(row) : row
}
