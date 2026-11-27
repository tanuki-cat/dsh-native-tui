import { Text, truncateToWidth, type Component } from '@earendil-works/pi-tui'

/**
 * Text whose every rendered row is clipped to the render width.
 *
 * Plain `Text` wraps at grapheme boundaries, so one grapheme wider than the
 * terminal keeps its full width and overflows the row. Notice and status rows
 * have no surrounding frame to absorb that, so they clip explicitly.
 */
export class ClippedText implements Component {
  private readonly body: Text

  constructor(text: string) {
    this.body = new Text(text, 0, 0)
  }

  render(width: number): string[] {
    const safe = Math.max(0, width)
    return this.body.render(safe).map(line => truncateToWidth(line, safe, '…'))
  }

  invalidate(): void { this.body.invalidate() }
}
