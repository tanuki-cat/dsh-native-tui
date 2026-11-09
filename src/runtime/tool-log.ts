/** One file's before/after text from a write/edit tool result. */
export interface ToolFileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

/** One tool call and its durable result extracted from a Session log. */
export interface ToolCallView {
  readonly callId: string
  readonly name: string
  readonly args: string
  readonly result?: string
  readonly isError?: boolean
  readonly diffs?: readonly ToolFileDiff[]
}

function asDiffs(meta: unknown): ToolFileDiff[] | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const diffs = (meta as { readonly diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const rows: ToolFileDiff[] = []
  for (const item of diffs) {
    if (item === null || typeof item !== 'object') return undefined
    const candidate = item as { readonly path?: unknown; readonly oldText?: unknown; readonly newText?: unknown }
    if (typeof candidate.path !== 'string' || typeof candidate.newText !== 'string') return undefined
    if (candidate.oldText !== null && typeof candidate.oldText !== 'string') return undefined
    rows.push({ path: candidate.path, oldText: candidate.oldText, newText: candidate.newText })
  }
  return rows
}

function contentText(message: { readonly content?: readonly unknown[] }): string {
  const parts: string[] = []
  for (const block of message.content ?? []) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { readonly type?: unknown; readonly text?: unknown; readonly name?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    else if (candidate.type === 'file') parts.push('[file]')
    else if (candidate.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' }
  catch { return '' }
}

/**
 * Collect native and PTC tool calls in first-call order, retaining their first result.
 * @param events - Session events in durable order.
 * @param maxCalls - maximum retained calls, keeping the newest.
 * @returns tool views without duplicates.
 */
export function collectToolCalls(
  events: readonly { readonly type: string; readonly data?: unknown }[],
  maxCalls = 100,
): ToolCallView[] {
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) throw new Error('tool maxCalls must be a positive safe integer')
  const byCall = new Map<string, ToolCallView>()
  const settled = new Set<string>()
  const order: string[] = []
  for (const event of events) {
    const ptc = event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
    const start = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
    if (!ptc && !start && event.type !== 'tool/result') continue
    const data = record(event.data)
    if (data === undefined) continue
    const message = ptc ? data : record(data.message)
    const callId = ptc ? data.subCallId : start ? data.callId : record(message?.source)?.callId
    if (typeof callId !== 'string') continue
    let call = byCall.get(callId)
    if ((start && call !== undefined) || settled.has(callId)) continue
    if (call === undefined) {
      if (!start && !ptc) continue
      call = { callId, name: typeof data.name === 'string' ? data.name : 'tool', args: argumentsText(data.arguments) }
      order.push(callId)
      byCall.set(callId, call)
    }
    if (start) continue
    const diffs = asDiffs(data.meta)
    byCall.set(callId, {
      ...call,
      ...(ptc && data.arguments !== undefined ? { args: argumentsText(data.arguments) } : {}),
      result: message === undefined ? undefined : contentText({ content: Array.isArray(message.content) ? message.content : [] }),
      ...(message?.isError === true ? { isError: true } : {}),
      ...(diffs === undefined ? {} : { diffs }),
    })
    settled.add(callId)
  }
  return order.slice(-maxCalls).map(callId => byCall.get(callId)!)
}
