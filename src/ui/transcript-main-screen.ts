import { TuiMainScreen, truncateToWidth } from '@earendil-works/pi-tui'

const sgr = /\u001B\[[0-9;]*m/gu
const marker = /^(?:\u001B\[[0-9;]*m)*• (?:\u001B\[[0-9;]*m)*/u
const editedSummary = /^• Edited \d+ files? /u

/** Defer offscreen lifecycle changes instead of clearing native terminal history. */
export class TranscriptMainScreen extends TuiMainScreen {
  override render(width: number): string[] {
    const lines = super.render(width)
    const previous = this.captureRenderState()
    if (previous.previousWidth !== width || previous.previousHeight !== this.terminal.rows) return lines
    const end = Math.min(previous.previousViewportTop, Math.max(0, lines.length - this.terminal.rows))
    const reset = this.applyLineResets([''])[0]!
    for (let index = 0; index < end; index += 1) {
      const before = previous.previousLines[index]
      const after = lines[index]
      if (before === undefined || after === undefined) continue
      if (before === after
        || (before.length === after.length + reset.length && before.endsWith(reset) && before.startsWith(after))) {
        continue
      }
      const previousMarker = marker.exec(before)?.[0]
      const nextMarker = marker.exec(after)?.[0]
      if (previousMarker === undefined || nextMarker === undefined) continue
      // Strip SGR only: a link target, image payload, or terminal control change
      // must still reach pi-tui's normal differential comparison.
      const normalized = this.applyLineResets([after])[0]!
      const plainBefore = before.replace(sgr, '')
      const plainAfter = normalized.replace(sgr, '')
      if (editedSummary.test(plainBefore) && editedSummary.test(plainAfter)
        && previous.previousLines[index + 1] === this.applyLineResets([lines[index + 1] ?? ''])[0]) {
        lines[index] = before.endsWith(reset) ? before.slice(0, -reset.length) : before
        continue
      }
      if (plainBefore === plainAfter) {
        lines[index] = previousMarker + after.slice(nextMarker.length)
      } else if (before.slice(previousMarker.length).startsWith('Running ') && after.slice(nextMarker.length).startsWith('Ran ')) {
        // Scrollback cannot be edited; a normal full redraw will show the settled tense.
        const running = truncateToWidth(nextMarker + 'Running ' + after.slice(nextMarker.length + 4), width, '…')
        if (plainBefore === this.applyLineResets([running])[0]!.replace(sgr, '')) {
          lines[index] = previousMarker + running.slice(nextMarker.length)
        }
      }
    }
    return lines
  }
}
