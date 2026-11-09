import { Container, Text, type Component } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'
import type { TranscriptBlock } from './transcript.js'
import { languageForPath } from './code-preview.js'
import { literalToolText, toolLabel, ToolOutput } from './tool-output.js'
import { ToolBody, toolHeading } from './transcript-chrome.js'
import { SourcePreview } from './source-preview.js'
import { toolActionLabel } from './tool-label.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const PREVIEW_LINES = 10

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
  container.addChild(toolHeading(palette.bold(toolActionLabel(block)), palette, block, displayPath === undefined ? undefined : palette.accent(displayPath)))
  const body = new Container()
  container.addChild(new ToolBody(body, palette))
  if (content !== undefined) {
    // Display source literally: model/file escape sequences must not control the terminal.
    const normalized = literalToolText(content)
    const lines = normalized.split('\n')
    while (lines.at(-1) === '') lines.pop()
    if (lines.length > 0) {
      const visible = lines.slice(0, expanded ? 2000 : PREVIEW_LINES)
      const source = visible.join('\n')
      const truncated = source.length > 65536
      const preview = source.slice(0, 65536)
      body.addChild(new SourcePreview(preview, languageForPath(path), palette))
      if (truncated || (expanded && lines.length > 2000)) body.addChild(new Text(palette.dim('… [content omitted by preview limit]'), 0, 0))
      if (lines.length > PREVIEW_LINES) {
        body.addChild(new Text(palette.dim(expanded
          ? `… (${String(lines.length)} total lines, ctrl+o to collapse)`
          : `… (${String(lines.length - PREVIEW_LINES)} more lines, ${String(lines.length)} total, ctrl+o to expand)`), 0, 0))
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
