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
