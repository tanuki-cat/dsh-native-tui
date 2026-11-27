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

/** Shared grapheme segmenter, matching the one pi-tui's wrapper uses. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Scripts pi-tui treats as per-character break opportunities. */
const CJK_BREAK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u

type TokenKind = 'space' | 'word'

interface SourceToken {
  start: number
  end: number
  readonly kind: TokenKind
}

/**
 * Split one newline-free source line into the same tokens `wrapTextWithAnsi`
 * uses, keeping source offsets so a wrapped visual line can be mapped back.
 * ANSI is not supported here; callers fall back to newline-only commits.
 * @param text - one source line, without escapes.
 * @returns tokens in source order.
 */
function sourceTokens(text: string): SourceToken[] {
  const tokens: SourceToken[] = []
  let current: SourceToken | undefined
  const flush = (): void => {
    if (current !== undefined) tokens.push(current)
    current = undefined
  }
  const add = (start: number, end: number, kind: TokenKind): void => {
    if (current !== undefined && current.kind === kind) current.end = end
    else {
      flush()
      current = { start, end, kind }
    }
  }
  // pi-tui skips grapheme segmentation for printable ASCII, so match it exactly.
  if (/^[\x20-\x7e]*$/u.test(text)) {
    for (let index = 0; index < text.length; index += 1) {
      add(index, index + 1, text[index] === ' ' ? 'space' : 'word')
    }
  }
  else {
    for (const segment of graphemeSegmenter.segment(text)) {
      const start = segment.index
      const value = segment.segment
      if (value === ' ') add(start, start + value.length, 'space')
      else if (CJK_BREAK.test(value)) {
        flush()
        tokens.push({ start, end: start + value.length, kind: 'word' })
      }
      else add(start, start + value.length, 'word')
    }
  }
  flush()
  return tokens
}

/** Whether a token's visible text is all whitespace, as `isWhitespaceToken` decides. */
function isWhitespaceToken(text: string): boolean {
  return !/\S/u.test(text)
}

/**
 * Source offset where the last visual line of a wrapped, newline-free line
 * begins.
 *
 * `wrapTextWithAnsi` is greedy and resets state at every visual line, so the
 * source prefix before that offset wraps to exactly every visual line before
 * the last one. The scan mirrors the wrapper's token and long-word breaking
 * without rendering, which lets a streaming append commit the finished lines.
 * @param text - one newline-free source line without ANSI escapes.
 * @param width - wrap width in terminal cells.
 * @returns the offset, or -1 when the line cannot be split safely.
 */
function lastVisualLineStart(text: string, width: number): number {
  if (text === '' || visibleWidth(text) <= width) return 0
  let currentWidth = 0
  let hasLine = false
  let lineStart = 0
  let lastStart = 0
  for (const token of sourceTokens(text)) {
    const tokenText = text.slice(token.start, token.end)
    const tokenWidth = visibleWidth(tokenText)
    const whitespace = token.kind === 'space' || isWhitespaceToken(tokenText)
    if (tokenWidth > width && !whitespace) {
      if (hasLine) {
        // The wrapper flushes the current line before breaking the long word.
        lastStart = lineStart
        hasLine = false
        currentWidth = 0
      }
      // `breakLongWord` produces one visual line per grapheme run that fits.
      let chunkStart = token.start
      let chunkWidth = 0
      for (const segment of graphemeSegmenter.segment(tokenText)) {
        const graphemeWidth = visibleWidth(segment.segment)
        // A single grapheme wider than the line makes the wrapper emit a
        // phantom empty line, which a tail-only re-wrap cannot reproduce.
        if (graphemeWidth > width) return -1
        if (chunkWidth + graphemeWidth > width) {
          lastStart = chunkStart
          chunkStart = token.start + segment.index
          chunkWidth = 0
        }
        chunkWidth += graphemeWidth
        hasLine = true
      }
      lineStart = chunkStart
      currentWidth = chunkWidth
      continue
    }
    if (currentWidth + tokenWidth > width && currentWidth > 0) {
      lastStart = lineStart
      if (whitespace) {
        // The dropped token is not part of the next visual line.
        lineStart = token.end
        currentWidth = 0
        hasLine = false
        continue
      }
      lineStart = token.start
      currentWidth = tokenWidth
      hasLine = true
      continue
    }
    if (!hasLine) lineStart = token.start
    currentWidth += tokenWidth
    hasLine = true
  }
  return hasLine ? lineStart : lastStart
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
    const wrapped = wrapTextWithAnsi(rest, contentWidth)
    // A newline-free tail grows without bound while it streams. Once it wraps
    // into several visual lines, commit every line but the active last one so
    // the next frame re-wraps only that line. ANSI state would not survive the
    // source cut, so escaped text keeps the newline-only boundary.
    const cut = contentWidth >= 2 && wrapped.length > 1 && !rest.includes('\x1b') && !rest.includes('\r')
      ? lastVisualLineStart(rest, contentWidth)
      : -1
    if (cut > 0 && cut < rest.length) {
      for (let index = 0; index < wrapped.length - 1; index += 1) {
        this.lines.push(this.pad(this.style(wrapped[index]!), contentWidth))
      }
      this.committedTo += cut
      this.committedCount = this.lines.length
      this.lines.push(this.pad(this.style(wrapped.at(-1)!), contentWidth))
    }
    else {
      for (const line of wrapped) this.lines.push(this.pad(this.style(line), contentWidth))
    }
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
