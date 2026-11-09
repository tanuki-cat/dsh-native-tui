import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'
import type { TranscriptBlock } from './transcript.js'

type ToolState = Pick<Extract<TranscriptBlock, { kind: 'tool' }>, 'pending' | 'isError' | 'stopped'>

function clipLine(text: string, width: number, palette: Palette): string {
  const clipped = truncateToWidth(text, width, '…')
  return palette.plain ? stripTerminalSequences(clipped) : clipped
}

/** Keep wrapped output attached to its tool without painting a full-width card. */
export class ToolBody implements Component {
  constructor(private readonly body: Component, private readonly palette: Palette) {}

  render(width: number): string[] {
    const inset = Math.min(4, Math.max(0, width - 1))
    return this.body.render(Math.max(1, width - inset)).map((line, index) => {
      const prefix = index === 0 && inset === 4 ? '  └ ' : ' '.repeat(inset)
      return clipLine(this.palette.dim(prefix) + line, width, this.palette)
    })
  }

  invalidate(): void { this.body.invalidate?.() }
}

/** Keep headings on one row and encode execution state in the marker color. */
export function toolHeading(text: string, palette: Palette, state: ToolState, tail?: string): Component {
  const marker = state.isError ? palette.error : state.stopped ? palette.dim : state.pending ? palette.warning : palette.success
  return {
    render: width => {
      const head = marker('• ') + text
      if (tail === undefined) return [clipLine(head, width, palette)]
      const available = Math.max(0, width - visibleWidth(head) - 1)
      const tailWidth = visibleWidth(tail)
      const shown = tailWidth > available
        ? '…' + sliceByColumn(tail, Math.max(0, tailWidth - available + 1), Math.max(0, available - 1)) : tail
      return [clipLine(head + ' ' + shown, width, palette)]
    },
    invalidate: () => {},
  }
}

/** A message marker appears once; subsequent wrapped lines keep the same inset. */
export class MessageBody implements Component {
  constructor(private readonly body: Component, private readonly palette: Palette, private readonly marker: string) {}

  render(width: number): string[] {
    const inset = Math.min(2, Math.max(0, width - 1))
    return this.body.render(Math.max(1, width - inset)).map((line, index) => {
      const prefix = index === 0 ? this.marker.slice(0, inset) : ' '.repeat(inset)
      return clipLine(this.palette.dim(prefix) + line, width, this.palette)
    })
  }

  invalidate(): void { this.body.invalidate?.() }
}

/** Fill a changed diff row through the viewport without carrying background state. */
export function diffRow(text: string, width: number, band: (text: string) => string): string {
  return band(text + ' '.repeat(Math.max(0, width - visibleWidth(text))))
}
