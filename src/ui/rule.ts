import type { Component } from '@earendil-works/pi-tui'

/** Full-width horizontal rule with optional horizontal padding. */
export class Rule implements Component {
  constructor(
    private readonly style: (text: string) => string,
    private readonly paddingX = 0,
  ) {}

  invalidate(): void {
    // The rule has no cached state.
  }

  render(width: number): string[] {
    const inner = Math.max(0, width - this.paddingX * 2)
    return [' '.repeat(this.paddingX) + this.style('─'.repeat(inner))]
  }
}
