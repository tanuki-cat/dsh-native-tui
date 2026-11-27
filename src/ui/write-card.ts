import { Container, Text, type Component } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'
import type { TranscriptBlock } from './transcript.js'
import { languageForPath } from './code-preview.js'
import { literalToolText, safeCut, toolLabel, ToolOutput } from './tool-output.js'
import { ToolBody, toolHeading } from './transcript-chrome.js'
import { SourcePreview } from './source-preview.js'
import { highlightToolLabel, toolActionLabel } from './tool-label.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const PREVIEW_LINES = 10
/** Characters one source preview can show, before literal escaping. */
const PREVIEW_CHARS = 65536
/** Raw margin so expansion by tabs or control bytes cannot starve the preview. */
const RAW_MARGIN = 4096

/**
 * Literal source for the small head of a potentially huge file.
 *
 * The card only paints at most `maxLines`, so the content is scanned for line
 * breaks without splitting or normalizing the whole file: each collected line
 * is cut with {@link safeCut}, and trailing empty lines are removed exactly as
 * `split('\\n')` plus `pop()` did.
 * @param content - file content as reported by the write call.
 * @param maxLines - lines a preview may show.
 * @returns the literal preview source and the file's non-trailing line count.
 */
function previewSource(content: string, maxLines: number): { readonly source: string; readonly total: number } {
  const lines: string[] = []
  const rawBudget = PREVIEW_CHARS + RAW_MARGIN
  let rawUsed = 0
  let totalSegments = 0
  let trailingEmpty = 0
  let index = 0
  while (true) {
    let end = index
    while (end < content.length && content[end] !== '\n' && content[end] !== '\r') end += 1
    const empty = end === index
    totalSegments += 1
    trailingEmpty = empty ? trailingEmpty + 1 : 0
    if (lines.length < maxLines && rawUsed < rawBudget) {
      const sliceEnd = safeCut(content, Math.min(end, index + rawBudget - rawUsed))
      const line = content.slice(index, sliceEnd)
      lines.push(line)
      rawUsed += line.length + 1
    }
    if (end >= content.length) break
    index = content[end] === '\r' && content[end + 1] === '\n' ? end + 2 : end + 1
  }
  // Everything after the last non-empty line was a trailing newline.
  lines.length = Math.min(lines.length, totalSegments - trailingEmpty)
  return { source: literalToolText(lines.join('\n')), total: totalSegments - trailingEmpty }
}

/** File content preview; successful writes never duplicate their result or masquerade as a diff. */
export function renderWriteCard(block: ToolBlock, palette: Palette, expanded = false): Component {
  let args: { file_path?: unknown; path?: unknown; content?: unknown } = {}
  try {
    const value: unknown = JSON.parse(block.args)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) args = value
  }
  catch { /* Durable metadata can still supply the file content. */ }
  const rawPath = args.file_path ?? args.path
  const path = typeof rawPath === 'string' ? rawPath : block.diffs?.[0]?.path
  const content = typeof args.content === 'string' ? args.content : block.diffs?.[0]?.newText
  const container = new Container()
  const displayPath = path === undefined ? undefined : toolLabel(literalToolText(path).replaceAll('\n', '\\x0a'), 160, 'end')
  container.addChild(toolHeading(highlightToolLabel(toolActionLabel(block), palette), palette, block, displayPath))
  const body = new Container()
  container.addChild(new ToolBody(body, palette))
  if (content !== undefined) {
    // Display source literally: model/file escape sequences must not control the terminal.
    const { source, total } = previewSource(content, expanded ? 2000 : PREVIEW_LINES)
    if (total > 0) {
      const truncated = source.length > PREVIEW_CHARS
      const preview = source.slice(0, safeCut(source, PREVIEW_CHARS))
      body.addChild(new SourcePreview(preview, languageForPath(path), palette))
      if (truncated || (expanded && total > 2000)) body.addChild(new Text(palette.dim('… [content omitted by preview limit]'), 0, 0))
      if (!expanded && total > PREVIEW_LINES) {
        body.addChild(new Text(palette.dim(`… (${String(total - PREVIEW_LINES)} more lines, ${String(total)} total)`), 0, 0))
      }
    }
  }
  else if (!(block.isError && block.result?.trim())) {
    body.addChild(new Text(palette.error('[invalid content arg - expected string]'), 0, 0))
  }
  if (block.isError) {
    if (block.result?.trim()) body.addChild(new ToolOutput(block.result, palette, expanded, 10, 'start', true))
    container.addChild(new Text(palette.error('  └ error'), 0, 0))
  }
  else if (block.pending) container.addChild(new Text(palette.warning('  └ running…'), 0, 0))
  else if (block.stopped) {
    if (block.result?.trim()) body.addChild(new ToolOutput(block.result, palette, expanded))
    container.addChild(new Text(palette.warning('  └ stopped · inspect the partial result'), 0, 0))
  }
  return container
}
