/**
 * Text block that wraps incrementally while it streams.
 *
 * pi-tui's `Text` re-wraps the whole string whenever the text changes, and a
 * streaming row changes on every frame: a 60 KB reasoning block measured ~6 ms
 * per frame, all of it in the wrap. `wrapTextWithAnsi` wraps each source line on
 * its own, so the lines above the last newline render identically no matter what
 * arrives after them. This component keeps those finished lines and re-wraps
 * only the trailing source line.
 *
 * @module dsh-native-tui/ui/stream-text
 */

import { visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'

/** pi-tui's `Text` renders a tab as three spaces; the cache has to normalize identically. */
function normalize(text: string): string {
  return text.replace(/\t/g, '   ')
}

/**
 * One text block whose finished lines survive an append.
 *
 * The output matches `new Text(text, 0, 0).render(width)` line for line, padding
 * and trailing blank lines included, so a row can switch to this component
 * without moving.
 */
export class StreamText implements Component {
  /** Text as received, so an append can be detected before normalization. */
  private raw: string
  /** Normalized text handed to the wrapper. */
  private text: string
  /** Rendered lines: the first {@link committedCount} are final and keep their style. */
  private lines: string[] = []
  /** Finished lines, already styled and padded for {@link width}. */
  private committedCount = 0
  /** Length of the prefix {@link committedCount} covers; always at a line start. */
  private committedTo = 0
  private width = -1
  private valid = true
  /** Characters handed to the wrapper, so tests can prove the finished lines are cached. */
  private wrapped = 0

  /**
   * @param text - initial text, unnormalized and unstyled.
   * @param style - per-line styling, applied after wrapping so no ANSI state
   *   has to survive a line boundary.
   */
  constructor(text = '', private readonly style: (line: string) => string = line => line) {
    this.raw = text
    this.text = normalize(text)
  }

  /**
   * Characters this component has wrapped since construction.
   * @internal Exposed so a test can prove finished lines are not re-wrapped.
   */
  get wrappedCharacters(): number {
    return this.wrapped
  }

  /**
   * Replace the text. An append keeps every finished line.
   * @param raw - the complete new text, not a delta.
   */
  setText(raw: string): void {
    if (raw === this.raw) return
    const appended = raw.startsWith(this.raw) ? raw.slice(this.raw.length) : undefined
    if (appended === undefined) {
      this.raw = raw
      this.text = normalize(raw)
      this.lines = []
      this.committedCount = 0
      this.committedTo = 0
    }
    else {
      this.raw = raw
      this.text += normalize(appended)
    }
    this.valid = false
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, Math.floor(width))
    if (this.valid && this.width === contentWidth) return this.lines
    if (this.width !== contentWidth) {
      // Finished lines are padded to their width, so a resize invalidates them.
      this.width = contentWidth
      this.lines = []
      this.committedCount = 0
      this.committedTo = 0
    }
    if (this.text === '' || this.text.trim() === '') {
      this.lines = []
      this.committedCount = 0
      this.valid = true
      return this.lines
    }
    // Drop the previous frame's tail before anything is appended.
    this.lines.length = this.committedCount
    const lineStart = this.text.lastIndexOf('\n') + 1
    if (lineStart > this.committedTo) {
      // The chunk ends with the newline that starts the line still being written,
      // so wrapping it also yields that next line as an empty entry. Dropping it
      // keeps the boundary out of the cache; the tail emits it when it is final.
      const chunk = this.text.slice(this.committedTo, lineStart)
      this.wrapped += chunk.length
      const wrapped = wrapTextWithAnsi(chunk, contentWidth)
      wrapped.pop()
      for (const line of wrapped) this.lines.push(this.pad(this.style(line), contentWidth))
      this.committedTo = lineStart
      this.committedCount = this.lines.length
    }
    const rest = this.text.slice(this.committedTo)
    this.wrapped += rest.length
    for (const line of wrapTextWithAnsi(rest, contentWidth)) this.lines.push(this.pad(this.style(line), contentWidth))
    this.valid = true
    return this.lines
  }

  invalidate(): void {
    this.width = -1
    this.lines = []
    this.committedCount = 0
    this.committedTo = 0
    this.valid = false
  }

  /** Pad one rendered line to the block width, exactly as `Text` does. */
  private pad(line: string, width: number): string {
    const missing = width - visibleWidth(line)
    return missing > 0 ? line + ' '.repeat(missing) : line
  }
}
