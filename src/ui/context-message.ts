import { Text, stripTerminalSequences, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { ToolBody } from './transcript-chrome.js'
import { clip } from './tool-preview.js'
import type { Palette } from './theme.js'
import type { TranscriptBlock } from './transcript.js'
import { detailsRow } from './details-row.js'

/** Context metadata stays compact while its original display text remains inspectable. */
export class ContextMessage implements Component {
  private readonly body: Component
  private readonly label: string
  private readonly hasBody: boolean
  private detailsY = 0

  constructor(block: Extract<TranscriptBlock, { kind: 'context' }>, private readonly palette: Palette,
    private expanded = false) {
    this.label = sanitizeTerminalText(block.label).replace(/\s+/gu, ' ').trim()
    const text = clip(sanitizeTerminalText(block.text))
    this.hasBody = text.trim() !== ''
    this.body = new ToolBody(new Text(palette.dim(text), 0, 0), palette)
  }

  setExpanded(expanded: boolean): void { this.expanded = expanded }

  get isExpanded(): boolean { return this.expanded }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.hasBody || event.type !== 'click' || event.button !== 'left' || (event.y !== 0 && event.y !== this.detailsY) || event.shift || event.alt || event.ctrl) return undefined
    this.expanded = !this.expanded
    return { handled: true }
  }

  render(width: number): string[] {
    const row = truncateToWidth(this.palette.dim('◇ context · ' + this.label), width, '…')
    const rows = [this.palette.plain ? stripTerminalSequences(row) : row,
      ...(this.expanded && this.hasBody ? this.body.render(width) : [])]
    this.detailsY = rows.length
    if (this.hasBody) rows.push(detailsRow(this.palette, this.expanded, width))
    return rows
  }

  invalidate(): void { this.body.invalidate?.() }
}
