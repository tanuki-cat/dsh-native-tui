import type { Palette } from './theme.js'

/**
 * The fullscreen viewport's jump-to-latest affordance.
 *
 * pi-tui composites the returned label on the last row of a follow-end primary
 * scroll view while that view is scrolled away from its end, and turns a click
 * on that row into `scrollToBottom()`. The label is rebuilt for every frame, so
 * it must stay cheap and free of state.
 *
 * Main-screen mode never shows it: the terminal owns scrollback there and
 * pi-tui has no viewport to measure.
 *
 * @module dsh-native-tui/ui/scroll-indicator
 */

/**
 * Style the jump-to-latest label.
 * @param palette - colours for the current theme.
 * @returns the label text; plain mode keeps it to the bare words.
 */
export function scrollToEndLabel(palette: Palette): string {
  return palette.accent('\u2193 ') + palette.dim('jump to latest')
}
