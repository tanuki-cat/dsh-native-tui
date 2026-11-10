import type { TranscriptBlock } from './transcript.js'
import type { Palette } from './theme.js'
import { literalToolText, toolLabel } from './tool-output.js'

type FileTool = Pick<Extract<TranscriptBlock, { kind: 'tool' }>, 'name' | 'pending' | 'operation' | 'diffs'>

/** Execution tense follows the Host lifecycle, including failed or stopped calls. */
export function executionVerb(pending: boolean): string {
  return pending ? 'Running' : 'Ran'
}

/** Host-confirmed updates include insertions into existing empty files. */
export function isWriteUpdate(block: FileTool): boolean {
  return block.name === 'write' && !block.pending && (block.operation === 'update'
    || (block.operation === undefined && block.diffs?.some(diff => diff.oldText !== null) === true))
}

/** Display action casing without changing service or method identifiers. */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name)
  if (mcp !== null) return 'MCP ' + mcp[1] + '/' + mcp[2]
  if (name === 'mcp') return 'MCP'
  if (name === 'grep' || name === 'glob' || name === 'find') return 'Search'
  const words = name.replace(/_+/gu, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Emphasize only the action; MCP server and method names remain literal targets. */
export function highlightToolLabel(label: string, palette: Palette): string {
  const safe = toolLabel(label, 120)
  return safe.startsWith('MCP ') ? palette.accent('MCP') + safe.slice(3) : palette.accent(safe)
}

/** File cards describe the applied operation; their recorded tool name stays intact. */
export function toolActionLabel(block: FileTool): string {
  return isWriteUpdate(block) ? 'Edit' : toolDisplayName(block.name)
}

/** Compact PTC rows retain their targets and only format the action prefix. */
export function compactToolLabel(line: string, palette: Palette): string {
  const safe = literalToolText(line)
  const space = safe.indexOf(' ')
  const name = space < 0 ? safe : safe.slice(0, space)
  return highlightToolLabel(toolDisplayName(name), palette) + (space < 0 ? '' : safe.slice(space))
}
