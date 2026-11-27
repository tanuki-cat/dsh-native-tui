import { Text, stripTerminalSequences, type Component } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'
import { highlightCode } from './code-preview.js'

const escaped = (character: string): string => '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0')

/** Source and paths are literal data, not terminal instructions. */
export function literalToolText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replaceAll('\t', '  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, escaped)
}

/** One bounded title or metadata label; paths can preserve their distinguishing tail. */
export function toolLabel(text: string, maxChars = 160, keep: 'start' | 'end' = 'start'): string {
  const normalized = literalToolText(text).replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  // The budget is in UTF-16 code units; clamping the cut keeps an emoji or any
  // other surrogate pair from being split into an isolated half.
  const budget = Math.max(0, maxChars - 1)
  return keep === 'end'
    ? '…' + normalized.slice(safeTailStart(normalized, normalized.length - budget))
    : normalized.slice(0, safeCut(normalized, budget)) + '…'
}

/**
 * Characters of a collapsed body that keep syntax colours.
 *
 * A collapsed card shows a handful of visual lines, but highlighting used to run
 * over the whole 64 KiB preview first and the visible slice was chosen after. The
 * window below covers far more than that row count can show, so only the end that
 * can actually appear is highlighted and the rest stays dim.
 */
const COLLAPSED_HIGHLIGHT_CHARS = 8192

/** Clamp an offset so it can never split a surrogate pair. */
export function safeCut(text: string, at: number): number {
  const cut = Math.max(0, Math.min(at, text.length))
  const previous = cut > 0 ? text.charCodeAt(cut - 1) : 0
  return previous >= 0xd800 && previous <= 0xdbff ? cut - 1 : cut
}

/** Clamp a tail start offset so it never begins on an orphaned low surrogate. */
export function safeTailStart(text: string, at: number): number {
  const start = Math.max(0, Math.min(at, text.length))
  const code = start < text.length ? text.charCodeAt(start) : 0
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start
}

/** Length of one terminal escape sequence at `at`, matching pi-tui's stripper. */
function terminalSequenceLength(raw: string, at: number): number {
  if (raw.charCodeAt(at) !== 0x1b) return 0
  const next = raw[at + 1]
  if (next === '[') {
    for (let index = at + 2; index < raw.length; index += 1) {
      const code = raw.charCodeAt(index)
      if (code === 0x6d || code === 0x47 || code === 0x4b || code === 0x48 || code === 0x4a) return index + 1 - at
    }
    return 0
  }
  if (next === ']' || next === '_') {
    for (let index = at + 2; index < raw.length; index += 1) {
      if (raw.charCodeAt(index) === 0x07) return index + 1 - at
      if (raw.charCodeAt(index) === 0x1b && raw[index + 1] === '\\') return index + 2 - at
    }
    return 0
  }
  return 0
}

/** Whether one normalized UTF-16 code unit is removed by `trimEnd`. */
function isTrimWhitespace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d)
  if (code < 0x7f) return false
  return /\s/u.test(String.fromCharCode(code))
}

/**
 * Measure the literal form of a tool result without allocating it.
 *
 * `literalToolText` changes the string's length: CRLF collapses, tabs expand,
 * and control bytes become `\\xNN`. Counting those while skipping terminal
 * sequences gives the omitted-character count the preview reports without
 * normalizing a multi-megabyte body first.
 * @param raw - unstripped tool output.
 * @returns normalized length and the length left after `trimEnd()`.
 */
function measureLiteral(raw: string): { readonly length: number; readonly trimmedLength: number } {
  let length = 0
  let trimmedLength = 0
  for (let index = 0; index < raw.length;) {
    const skip = terminalSequenceLength(raw, index)
    if (skip > 0) {
      index += skip
      continue
    }
    const code = raw.charCodeAt(index)
    if (code === 0x0d) {
      // Stripping happens before CRLF normalization, so an escape sequence
      // between CR and LF still lets the pair collapse into one newline.
      let next = index + 1
      while (next < raw.length) {
        const skip = terminalSequenceLength(raw, next)
        if (skip === 0) break
        next += skip
      }
      length += 1
      index = raw.charCodeAt(next) === 0x0a ? next + 1 : index + 1
    }
    else if (code === 0x09) {
      length += 2
      index += 1
    }
    else if (code <= 0x08 || code >= 0x0b && code <= 0x1f || code >= 0x7f && code <= 0x9f) {
      length += 4
      trimmedLength = length
      index += 1
    }
    else {
      length += 1
      if (!isTrimWhitespace(code)) trimmedLength = length
      index += 1
    }
  }
  return { length, trimmedLength }
}

/**
 * Normalize only the raw window that can contribute to one bounded preview.
 * @param raw - unstripped tool output.
 * @param budget - normalized characters the preview can show.
 * @param keep - whether the preview keeps the start or the end.
 * @returns normalized text long enough to slice `budget` characters, or the
 *   whole normalized body when it is shorter.
 */
function boundedLiteral(raw: string, budget: number, keep: 'start' | 'end'): string {
  const margin = 4096
  let window = Math.min(raw.length, budget * 2 + margin)
  while (true) {
    const start = keep === 'end' ? safeTailStart(raw, raw.length - window) : 0
    const end = keep === 'end' ? raw.length : window
    const normalized = literalToolText(stripTerminalSequences(raw.slice(start, end)))
    const text = keep === 'end' ? normalized.trimEnd() : normalized
    if (text.length >= budget + 2 || window >= raw.length) return text
    window = Math.min(raw.length, window * 2 + margin)
  }
}

/**
 * Highlight the part of a body that can be shown.
 * @param text - literal preview text.
 * @param language - highlight.js language id.
 * @param palette - active palette; `plain` keeps the source unchanged.
 * @param keep - which end the collapsed card displays.
 * @param expanded - whether the whole body is on screen.
 * @returns the styled text.
 */
function highlightWindow(
  text: string,
  language: string,
  palette: Palette,
  keep: 'start' | 'end',
  expanded: boolean,
): string {
  if (expanded || text.length <= COLLAPSED_HIGHLIGHT_CHARS) return highlightCode(text, language, palette)
  const cut = safeCut(text, keep === 'end' ? text.length - COLLAPSED_HIGHLIGHT_CHARS : COLLAPSED_HIGHLIGHT_CHARS)
  return keep === 'end'
    ? palette.dim(text.slice(0, cut)) + highlightCode(text.slice(cut), language, palette)
    : highlightCode(text.slice(0, cut), language, palette) + palette.dim(text.slice(cut))
}

/** A bounded visual-line preview; shell results keep their diagnostic tail. */
export class ToolOutput implements Component {
  private readonly text: Text
  private readonly omitted: number
  constructor(raw: string, private readonly palette: Palette, private readonly expanded: boolean,
    private readonly limit = 10, private readonly keep: 'start' | 'end' = 'start', error = false, language?: string) {
    const budget = 65536
    const measured = measureLiteral(raw)
    // Normalize only the window the preview can show; a multi-megabyte body is
    // never copied whole just to choose the first/last 64 KiB of it.
    const normalized = measured.trimmedLength <= budget
      ? literalToolText(stripTerminalSequences(raw)).trimEnd()
      : boundedLiteral(raw, budget, keep)
    const bounded = normalized.length <= budget ? normalized
      : keep === 'end'
        ? normalized.slice(safeTailStart(normalized, normalized.length - budget))
        : normalized.slice(0, safeCut(normalized, budget))
    this.omitted = Math.max(0, measured.trimmedLength - bounded.length)
    this.text = new Text(error
      ? palette.error(bounded)
      : language === undefined ? palette.dim(bounded) : highlightWindow(bounded, language, palette, keep, expanded), 0, 0)
  }

  render(width: number): string[] {
    const all = this.text.render(width)
    const hidden = this.expanded ? 0 : Math.max(0, all.length - this.limit)
    const lines = hidden === 0 ? [...all] : this.keep === 'end' ? all.slice(-this.limit) : all.slice(0, this.limit)
    if (hidden > 0) {
      lines.push(...new Text(this.palette.dim('… ' + hidden + (this.keep === 'end' ? ' earlier lines' : ' more lines')), 0, 0).render(width))
    }
    if (this.omitted > 0) lines.push(...new Text(this.palette.dim('… [' + this.omitted + ' chars omitted by preview limit]'), 0, 0).render(width))
    return lines
  }

  invalidate(): void { this.text.invalidate() }
}
