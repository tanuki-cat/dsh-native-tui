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
  return keep === 'end' ? '…' + normalized.slice(-(maxChars - 1)) : normalized.slice(0, maxChars - 1) + '…'
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
function safeCut(text: string, at: number): number {
  const cut = Math.max(0, Math.min(at, text.length))
  const previous = cut > 0 ? text.charCodeAt(cut - 1) : 0
  return previous >= 0xd800 && previous <= 0xdbff ? cut - 1 : cut
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
    const normalized = literalToolText(stripTerminalSequences(raw)).trimEnd()
    const budget = 65536
    this.omitted = Math.max(0, normalized.length - budget)
    const bounded = normalized.length <= budget ? normalized
      : keep === 'end' ? normalized.slice(-budget) : normalized.slice(0, budget)
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
