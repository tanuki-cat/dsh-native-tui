import { Container, Spacer, type Component } from '@earendil-works/pi-tui'

/** Vertical breathing room without measuring every retained transcript line. */
export class TranscriptBody extends Container {
  constructor(content: Component) {
    super()
    this.addChild(new Spacer(1))
    this.addChild(content)
    this.addChild(new Spacer(1))
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length === 2) return []
    const blank = ' '.repeat(Math.max(0, Math.floor(width)))
    lines[0] = blank
    lines[lines.length - 1] = blank
    return lines
  }
}
