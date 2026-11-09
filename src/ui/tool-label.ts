import type { TranscriptBlock } from './transcript.js'

type FileTool = Pick<Extract<TranscriptBlock, { kind: 'tool' }>, 'name' | 'pending' | 'operation' | 'diffs'>

/** Host-confirmed updates include insertions into existing empty files. */
export function isWriteUpdate(block: FileTool): boolean {
  return block.name === 'write' && !block.pending && (block.operation === 'update'
    || (block.operation === undefined && block.diffs?.some(diff => diff.oldText !== null) === true))
}

/** Display action casing without changing service or method identifiers. */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name)
  if (mcp !== null) return 'MCP ' + mcp[1] + '/' + mcp[2]
  return name === 'mcp' ? 'MCP' : name.charAt(0).toUpperCase() + name.slice(1)
}

/** File cards describe the applied operation; their recorded tool name stays intact. */
export function toolActionLabel(block: FileTool): string {
  return isWriteUpdate(block) ? 'Edit' : toolDisplayName(block.name)
}

/** Compact PTC rows retain their targets and only format the action prefix. */
export function compactToolLabel(line: string): string {
  const space = line.indexOf(' ')
  return space < 0 ? toolDisplayName(line) : toolDisplayName(line.slice(0, space)) + line.slice(space)
}
