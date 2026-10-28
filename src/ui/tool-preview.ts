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
 * @param limit - maximum characters, including an explicit truncation marker.
 * @returns a single row bounded by limit.
 */
function boundedLine(value: string, keep: KeepEnd, limit = PTC_TARGET_CHARS): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact.length <= limit) return compact
  const budget = limit - 1
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

function scriptLine(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== ''
    ? boundedLine(value.replace(/\r\n|[\r\n]/gu, ' ↵ '), 'head', 120) : undefined
}

/** Select an action or target without dumping file contents or edit bodies. */
function callTarget(record: Record<string, unknown>): string | undefined {
  const command = scriptLine(record, 'command')
  if (command !== undefined) return command
  for (const key of ['file_path', 'filePath', 'pathInProject', 'path', 'directoryPath', 'file_path_relative']) {
    const path = lineArgument(record, key, 'tail')
    if (path !== undefined) return path
  }
  for (const key of ['files', 'filesToRebuild']) {
    const paths = record[key]
    if (Array.isArray(paths) && paths.every(path => typeof path === 'string')) return boundedLine(paths.join(', '), 'tail')
  }
  return lineArgument(record, 'symbolFqn') ?? lineArgument(record, 'q') ?? lineArgument(record, 'queryText')
    ?? lineArgument(record, 'pattern') ?? lineArgument(record, 'url') ?? lineArgument(record, 'uri')
    ?? firstQuery(record) ?? lineArgument(record, 'description')
}

function jobOutputTarget(record: Record<string, unknown>): string | undefined {
  const id = lineArgument(record, 'job_id', 'tail')
  if (id === undefined) return undefined
  if (record.wait === undefined || record.wait === false) return id + ' · poll'
  if (record.wait !== true) return id
  const timeout = record.timeout_ms
  const limit = typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
    ? ' · timeout ' + (timeout % 1000 === 0 ? timeout / 1000 + 's' : timeout + 'ms') : ''
  return id + ' · wait' + limit
}

function todoTarget(record: Record<string, unknown>): string | undefined {
  if (!Array.isArray(record.todos)) return undefined
  const todos = record.todos.filter((todo): todo is Record<string, unknown> => todo !== null && typeof todo === 'object' && !Array.isArray(todo))
  const active = todos.filter(todo => todo.status === 'in_progress')
  const done = todos.filter(todo => todo.status === 'completed').length
  const current = active[0] ?? todos.find(todo => todo.status === 'pending')
  const summary = record.todos.length === 0 ? '0 tasks · clear list' : String(record.todos.length) + ' tasks · ' + active.length + ' active · ' + done + ' done'
  const target = current === undefined ? undefined : lineArgument(current, 'content')
  return summary + (target === undefined ? '' : ' · ' + target)
}

/**
 * Compact row for one sub-call a `run_code` program dispatched: the tool name
 * followed by what it worked on. File tools name the path (`read src/a.ts`),
 * shells show the actual command, MCP tools show server.method and target,
 * and todo_write shows task counts and the active or next task.
 * @param name - sub-call tool name.
 * @param args - sub-call arguments, a JSON string or already-serialized object.
 * @returns one row; the bare tool name when no target applies.
 */
export function ptcCallLine(name: string, args: string): string {
  const mcp = MCP_TOOL_NAME.exec(name)
  const record = argumentRecord(args)
  if (mcp !== null) {
    const method = 'mcp ' + boundedLine(mcp[1]!, 'head') + '.' + boundedLine(mcp[2]!, 'head')
    const target = record === undefined ? undefined : callTarget(record)
    return method + (target === undefined ? '' : ' ' + target)
  }
  if (record === undefined) return name
  if (name === 'job_output') {
    const target = jobOutputTarget(record)
    return target === undefined ? name : name + ' ' + target
  }
  const target = name === 'run_code' ? scriptLine(record, 'code') ?? callTarget(record)
    : name === 'bash' || name === 'pwsh'
    ? callTarget(record)
    : name === 'grep' || name === 'glob' || name === 'find'
      ? lineArgument(record, 'pattern') ?? lineArgument(record, 'path', 'tail')
      : name === 'web_search'
        ? firstQuery(record) ?? lineArgument(record, 'url')
        : name === 'skill' ? lineArgument(record, 'name')
          : name === 'todo_write' ? todoTarget(record) ?? callTarget(record) : callTarget(record)
  const cwd = name === 'bash' || name === 'pwsh' ? lineArgument(record, 'workdir', 'tail') : undefined
  return (target === undefined ? name : name + ' ' + target) + (cwd === undefined ? '' : ' · cwd ' + cwd)
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
