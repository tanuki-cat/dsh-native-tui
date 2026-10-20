import type { Component } from '@earendil-works/pi-tui'

/**
 * Horizontal rule that fills the width its parent hands it.
 *
 * The component owns no inset: it paints every column it is given, so the line
 * always spans its container edge to edge and follows a resize without any
 * stored width or margin. Containers (the transcript column, the app layout)
 * decide the inset by rendering the rule narrower.
 */
export class Rule implements Component {
  constructor(private readonly style: (text: string) => string) {}

  invalidate(): void {
    // The rule has no cached state.
  }

  render(width: number): string[] {
    return [this.style('─'.repeat(Math.max(0, Math.floor(width))))]
  }
}
