/**
 * Display preparation for model reasoning.
 *
 * A provider may return its reasoning wrapped in a `<signature>` block. The
 * stripping lives here rather than in the event projection: the session log
 * keeps what the model actually sent, and only what reaches the screen changes.
 *
 * @module dsh-native-tui/ui/reasoning-text
 */

/** Opening marker one provider puts in front of the reasoning it returns. */
const OPENING = '<signature>'

/** Closing marker of that signature block. */
const CLOSING = '</signature>'

/**
 * Prepare complete or streaming reasoning for display.
 *
 * A partial opening marker and an unclosed block both display as nothing: the
 * visible body must never contain a half-received tag.
 * @param text - original complete or streaming reasoning.
 * @returns display text, or empty text when nothing is displayable yet.
 */
export function reasoningText(text: string): string {
  if (text[0] !== '<') return text
  if (OPENING.startsWith(text)) return ''
  if (!text.startsWith(OPENING)) return text
  const end = text.indexOf(CLOSING, OPENING.length)
  if (end === -1) return ''
  let start = end + CLOSING.length
  while (start < text.length) {
    if (text[start] === '\n') start += 1
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2
    else break
  }
  return text.slice(start)
}

/**
 * First line of a text.
 * @param text - one or more lines.
 * @returns the first line without surrounding whitespace.
 */
export function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}

/**
 * First line of the last paragraph whose own first line has completed.
 *
 * A streaming reasoning advances paragraph by paragraph, so a preview anchored
 * to the newest completed paragraph follows the model instead of freezing on
 * the opening line. A paragraph counts as completed once it holds a newline.
 * @param text - complete or streaming reasoning.
 * @returns the last completed paragraph's first line, or empty text.
 */
export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  // A fresh expression per call: a shared global one would carry lastIndex in.
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/** First line carrying text, or empty when every line is blank. */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * Collapsed one-line preview for one reasoning block.
 *
 * The compact row is a single line with no disclosure header to fall back on,
 * so a preview that would be empty keeps the first visible line instead of
 * rendering a label with nothing after it.
 * @param text - original or already prepared reasoning.
 * @param running - whether the reasoning tail is still streaming.
 * @returns the preview line, without markdown emphasis markers.
 */
export function reasoningPreview(text: string, running: boolean): string {
  const display = reasoningText(text)
  const summary = running ? latestCompletedParagraphFirstLine(display) : firstLine(display)
  const line = summary === '' ? firstNonEmptyLine(display) : summary
  return line.replaceAll('**', '').trim()
}
