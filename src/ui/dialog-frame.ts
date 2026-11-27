import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'

/** Render a full-width, opaque dialog surface so the transcript cannot bleed through. */
export function dialogFrame(lines: readonly string[], width: number, palette: Palette): string[] {
  if (width < 6) {
    const safe = Math.max(0, width)
    return lines.map((line) => {
      const bounded = truncateToWidth(line, safe, '…')
      const clipped = palette.plain ? bounded.replace(/\x1b\[[0-9;]*m/gu, '') : bounded
      return palette.dialogBand(clipped + ' '.repeat(Math.max(0, safe - visibleWidth(clipped))))
    })
  }
  const outer = width
  const inner = Math.max(1, outer - 4)
  const content = lines.map((line) => {
    const bounded = truncateToWidth(line, inner)
    // Native cursor markers must survive plain mode; SGR resets from truncation need not.
    const clipped = palette.plain ? bounded.replace(/\x1b\[[0-9;]*m/gu, '') : bounded
    return palette.dialogBand('│ ' + clipped)
      + palette.dialogBand(' '.repeat(Math.max(0, inner - visibleWidth(clipped))) + ' │')
  })
  return [palette.dialogBand('┌' + '─'.repeat(outer - 2) + '┐'), ...content,
    palette.dialogBand('└' + '─'.repeat(outer - 2) + '┘')]
}
