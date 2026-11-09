import { TuiMainScreen } from '@earendil-works/pi-tui'

const sgr = /\u001B\[[0-9;]*m/gu
const marker = /^(?:\u001B\[[0-9;]*m)*• (?:\u001B\[[0-9;]*m)*/u

/** Defer offscreen marker recoloring instead of clearing native terminal history. */
export class TranscriptMainScreen extends TuiMainScreen {
  override render(width: number): string[] {
    const lines = super.render(width)
    const previous = this.captureRenderState()
    if (previous.previousWidth !== width || previous.previousHeight !== this.terminal.rows) return lines
    const end = Math.min(previous.previousViewportTop, Math.max(0, lines.length - this.terminal.rows))
    for (let index = 0; index < end; index += 1) {
      const before = previous.previousLines[index]
      const after = lines[index]
      if (before === undefined || after === undefined) continue
      const previousMarker = marker.exec(before)?.[0]
      const nextMarker = marker.exec(after)?.[0]
      if (previousMarker === undefined || nextMarker === undefined) continue
      // Strip SGR only: a link target, image payload, or terminal control change
      // must still reach pi-tui's normal differential comparison.
      const normalized = this.applyLineResets([after])[0]!
      if (before.replace(sgr, '') === normalized.replace(sgr, '')) {
        lines[index] = previousMarker + after.slice(nextMarker.length)
      }
    }
    return lines
  }
}
