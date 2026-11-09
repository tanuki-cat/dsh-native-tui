import { Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { highlightCode } from './code-preview.js'
import type { Palette } from './theme.js'

/** Number source lines once; wrapped continuations retain an empty number gutter. */
export class SourcePreview implements Component {
  private readonly lines: Text[]
  private readonly gutter: number

  constructor(source: string, language: string | undefined, private readonly palette: Palette) {
    const lines = wrapTextWithAnsi(highlightCode(source, language, palette), Math.max(1, source.length * 2))
    this.gutter = String(lines.length).length
    this.lines = lines.map(line => new Text(line, 0, 0))
  }

  render(width: number): string[] {
    const prefixWidth = this.gutter + 2
    return this.lines.flatMap((body, index) => {
      const lines = body.render(Math.max(1, width - prefixWidth))
      return (lines.length === 0 ? [''] : lines).map((line, wrap) => {
        const number = wrap === 0 ? String(index + 1).padStart(this.gutter) : ' '.repeat(this.gutter)
        const text = truncateToWidth(this.palette.dim(number + '  ') + line, width, '…')
        return this.palette.plain ? stripTerminalSequences(text) : text
      })
    })
  }

  invalidate(): void { for (const line of this.lines) line.invalidate() }
}
