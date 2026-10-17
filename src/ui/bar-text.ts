import { visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'

/**
 * Text block whose wrapped lines all retain a visible left bar.
 * Plain {@link Text} only prefixes the first physical line, which makes long
 * context and tool output look detached after terminal wrapping.
 */
export class BarText implements Component {
  constructor(
    private readonly text: string,
    private readonly prefix: string,
    private readonly bodyStyle: (text: string) => string = text => text,
    private readonly prefixStyle: (text: string) => string = text => text,
  ) {}

  invalidate(): void {
    // Rendering is stateless and cheap; the parent redraws on content changes.
  }

  render(width: number): string[] {
    if (this.text.trim() === '') return []
    const prefixWidth = visibleWidth(this.prefix)
    const wrapped = wrapTextWithAnsi(this.text, Math.max(1, width - prefixWidth))
    return wrapped.map(line => this.prefixStyle(this.prefix) + this.bodyStyle(line))
  }
}
