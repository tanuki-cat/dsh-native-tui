import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'

/**
 * The fullscreen viewport's jump-to-latest affordance.
 *
 * A reserved row between the transcript and composer keeps the action visible
 * while the reader browses history, without covering the transcript text.
 *
 * Main-screen mode never shows it: the terminal owns scrollback there and
 * pi-tui has no viewport to measure.
 *
 * @module dsh-native-tui/ui/scroll-indicator
 */

/**
 * Style the return-to-bottom label.
 * @param palette - colours for the current theme.
 * @returns the label text; plain mode keeps it to the bare words.
 */
export function scrollToEndLabel(palette: Palette): string {
  return palette.accent('↓ Back to bottom · esc')
}

/** A fixed-height, centered button that restores output following. */
export class ScrollToLatest implements Component {
  private start = 0
  private end = 0

  constructor(private readonly palette: Palette, private readonly following: () => boolean,
    private readonly jump: () => void) {}

  render(width: number): string[] {
    this.start = this.end = 0
    if (this.following()) return ['']
    const label = truncateToWidth(' ' + scrollToEndLabel(this.palette) + ' ', Math.max(0, width), '…')
    const buttonWidth = visibleWidth(label)
    this.start = Math.max(0, Math.floor((width - buttonWidth) / 2))
    this.end = this.start + buttonWidth
    const row = ' '.repeat(this.start) + this.palette.dialogBand(label)
    return [this.palette.plain ? stripTerminalSequences(row) : row]
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.following() || event.type !== 'click' || event.button !== 'left' || event.y !== 0
      || event.shift || event.alt || event.ctrl || event.x < this.start || event.x >= this.end) return undefined
    this.jump()
    return { handled: true }
  }

  invalidate(): void {}
}
