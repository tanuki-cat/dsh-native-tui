import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'
import type { TranscriptBlock } from './transcript.js'
import { highlightCode, languageForPath } from './code-preview.js'
import { clip } from './tool-preview.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const PREVIEW_LINES = 10

const escapeControl = (character: string): string => '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0')

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
  const displayPath = path?.replace(/[\x00-\x1f\x7f]/g, escapeControl)
  container.addChild(new Text(palette.bold('write') + (displayPath === undefined ? '' : ' ' + palette.accent(displayPath)), 0, 0))
  if (content !== undefined) {
    // Display source literally: model/file escape sequences must not control the terminal.
    const normalized = content.replace(/\r\n?/g, '\n').replaceAll('\t', '  ')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, escapeControl)
    const lines = normalized.split('\n')
    while (lines.at(-1) === '') lines.pop()
    if (lines.length > 0) {
      const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES)
      container.addChild(new Spacer(1))
      container.addChild(new Text(highlightCode(visible.join('\n'), languageForPath(path), palette), 0, 0))
      if (lines.length > PREVIEW_LINES) {
        container.addChild(new Text(palette.dim(expanded
          ? `… (${String(lines.length)} total lines, ctrl+o to collapse)`
          : `… (${String(lines.length - PREVIEW_LINES)} more lines, ${String(lines.length)} total, ctrl+o to expand)`), 0, 0))
      }
    }
  }
  else if (!(block.isError && block.result?.trim())) {
    container.addChild(new Text(palette.error('[invalid content arg - expected string]'), 0, 0))
  }
  if (block.isError) {
    if (block.result?.trim()) container.addChild(new Text(palette.error(clip(block.result)), 0, 0))
    container.addChild(new Text(palette.error('└ error'), 0, 0))
  }
  else if (block.pending) container.addChild(new Text(palette.warning('└ running…'), 0, 0))
  return container
}
