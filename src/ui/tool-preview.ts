/**
 * Bounded, line-oriented previews for tool arguments, results, and compact
 * code-execution rows.
 *
 * @module dsh-native-tui/ui/tool-preview
 */

/** Maximum characters retained in one tool preview. */
const TOOL_PREVIEW = 1200

/** Clip one line-oriented preview without changing its content. */
export function clip(text: string, limit = TOOL_PREVIEW): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [${String(text.length - limit)} chars omitted]`
}

/**
 * Format a model-produced JSON argument string for a readable tool call.
 * Known fields keep their names; long string values such as code are split
 * into indented rows instead of one wrapped JSON line.
 * @param raw - raw JSON arguments from the tool call.
 * @returns a bounded, multi-line display value.
 */
export function formatToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return clip(trimmed, TOOL_PREVIEW)
  }
  if (value === null || typeof value !== 'object') return clip(String(value), TOOL_PREVIEW)
  const rows: Array<readonly [string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>)
  const lines: string[] = []
  for (const [key, item] of rows.slice(0, 12)) {
    if (typeof item === 'string') {
      const text = clip(item, 900)
      if (text.includes('\n')) {
        lines.push(key + ':')
        for (const line of text.split('\n')) lines.push('  ' + line)
      } else {
        lines.push(key + ': ' + text)
      }
    } else {
      lines.push(key + ': ' + clip(JSON.stringify(item) ?? String(item), 500))
    }
  }
  if (rows.length > 12) lines.push('… ' + String(rows.length - 12) + ' more fields')
  return clip(lines.join('\n'), 2400)
}

/** MCP tool names are `mcp__<server>__<tool>`, as dsh-mcp-client registers them. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/u

/** Longest target kept after a compact PTC call's tool name. */
const PTC_TARGET_CHARS = 64

/**
 * Which end of an over-long value survives, chosen by where its distinguishing
 * part sits: a path differs in its file name, prose differs at its start.
 */
type KeepEnd = 'head' | 'tail'

/**
 * Collapse a possibly multi-line argument value into one bounded row.
 *
 * The tail is kept for paths on purpose: two files in the same deep directory
 * share a prefix, so truncating from the left would render them as the same
 * row and deduplicate one of them away.
 * @param value - raw argument value.
 * @param keep - end that survives truncation.
 * @returns one row of at most {@link PTC_TARGET_CHARS} characters.
 */
function boundedLine(value: string, keep: KeepEnd): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact.length <= PTC_TARGET_CHARS) return compact
  const budget = PTC_TARGET_CHARS - 1
  return keep === 'tail'
    ? '…' + compact.slice(compact.length - budget)
    : compact.slice(0, budget) + '…'
}

/** Read one non-empty string argument as a bounded single line. */
function lineArgument(record: Record<string, unknown>, key: string, keep: KeepEnd = 'head'): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? boundedLine(value, keep) : undefined
}

/** Parse tool arguments when they are a JSON object. */
function argumentRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  }
  catch { return undefined }
}

/** First non-empty query from `web_search`'s query list. */
function firstQuery(record: Record<string, unknown>): string | undefined {
  const queries = record.queries
  if (Array.isArray(queries)) {
    for (const query of queries) {
      if (typeof query === 'string' && query.trim() !== '') return boundedLine(query, 'head')
    }
  }
  return lineArgument(record, 'query')
}

/**
 * Compact row for one sub-call a `run_code` program dispatched: the tool name
 * followed by what it worked on. File tools name the path (`read src/a.ts`),
 * shells name their description or command, and MCP tools name their server
 * (`mcp idea`) rather than the registered `mcp__server__tool` identifier.
 * @param name - sub-call tool name.
 * @param args - sub-call arguments, a JSON string or already-serialized object.
 * @returns one row; the bare tool name when no target applies.
 */
export function ptcCallLine(name: string, args: string): string {
  const mcp = MCP_TOOL_NAME.exec(name)
  if (mcp !== null) return 'mcp ' + boundedLine(mcp[1]!, 'head')
  const record = argumentRecord(args)
  if (record === undefined) return name
  const target = name === 'bash' || name === 'pwsh'
    ? lineArgument(record, 'description') ?? lineArgument(record, 'command')
    : name === 'grep' || name === 'glob' || name === 'find'
      ? lineArgument(record, 'pattern') ?? lineArgument(record, 'path', 'tail')
      : name === 'web_search'
        ? firstQuery(record) ?? lineArgument(record, 'url')
        : lineArgument(record, 'file_path', 'tail') ?? lineArgument(record, 'path', 'tail')
          ?? lineArgument(record, 'pattern') ?? lineArgument(record, 'url') ?? firstQuery(record)
          ?? lineArgument(record, 'command') ?? lineArgument(record, 'description')
  return target === undefined ? name : name + ' ' + target
}

/** Longest failure message a compact code-execution row keeps. */
const COMPACT_ERROR_CHARS = 220

/**
 * First line of a failed tool result, for the compact code-execution card.
 *
 * A compact card that lists dispatched calls drops the result summary, which
 * leaves a failed card reading only `error`. The failure text is the one part
 * of that result a reader needs, so it stays.
 * @param result - raw tool result text.
 * @returns one bounded row, empty when there is no message.
 */
export function compactErrorPreview(result: string | undefined): string {
  if (result === undefined) return ''
  const line = result.split('\n').map(row => row.trim()).find(row => row !== '') ?? ''
  const compact = line.replace(/\s+/gu, ' ')
  return compact.length <= COMPACT_ERROR_CHARS ? compact : compact.slice(0, COMPACT_ERROR_CHARS - 1) + '…'
}

/** Extract a one-line description for a compact code-execution row. */
export function compactCodeExecutionPreview(block: { readonly args: string; readonly result?: string }): string {
  let description: string | undefined
  try {
    const parsed: unknown = JSON.parse(block.args)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      if (typeof record.description === 'string' && record.description.trim() !== '') description = record.description
      else if (typeof record.command === 'string' && record.command.trim() !== '') description = record.command
      else if (typeof record.code === 'string' && record.code.trim() !== '') description = record.code
    }
  }
  catch { /* Keep the result preview when arguments are not JSON. */ }
  const firstLine = (text: string | undefined): string =>
    text?.split('\n').map(line => line.trim()).find(line => line !== '')?.replace(/\s+/gu, ' ') ?? ''
  const result = firstLine(block.result)
  const action = firstLine(description ?? block.args)
  const parts = action === '' ? [result] : result === '' || result === action ? [action] : [action, result]
  return clip(parts.filter(part => part !== '').join(' · '), 220)
}
