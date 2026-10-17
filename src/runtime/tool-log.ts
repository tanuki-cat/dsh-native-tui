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

/**
 * Collect tool calls in first-call order, attaching results by call id.
 * @param events - Session events in durable order.
 * @param maxCalls - maximum retained calls, keeping the newest.
 * @returns tool views without duplicates.
 */
export function collectToolCalls(
  events: readonly { readonly type: string; readonly data?: unknown }[],
  maxCalls = 100,
): ToolCallView[] {
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) throw new Error('tool maxCalls must be a positive safe integer')
  const byCall = new Map<string, { view: ToolCallView; index: number }>()
  const order: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown } | undefined
      if (typeof data?.callId !== 'string') continue
      if (byCall.has(data.callId)) continue
      order.push(data.callId)
      byCall.set(data.callId, {
        index: order.length - 1,
        view: {
          callId: data.callId,
          name: typeof data.name === 'string' ? data.name : 'tool',
          args: typeof data.arguments === 'string' ? data.arguments : String(data.arguments ?? ''),
        },
      })
    } else if (event.type === 'tool/result') {
      const data = event.data as {
        readonly message?: { readonly source?: { readonly callId?: unknown }; readonly content?: readonly unknown[]; readonly isError?: unknown }
        readonly meta?: unknown
      } | undefined
      const callId = data?.message?.source?.callId
      if (typeof callId !== 'string') continue
      const entry = byCall.get(callId)
      if (entry === undefined) continue
      byCall.set(callId, {
        index: entry.index,
        view: {
          ...entry.view,
          result: data?.message === undefined ? undefined : contentText(data.message),
          ...(data?.message?.isError === true ? { isError: true } : {}),
          ...(asDiffs(data?.meta) === undefined ? {} : { diffs: asDiffs(data?.meta) }),
        },
      })
    }
  }
  return order.map(callId => byCall.get(callId)!.view).slice(-maxCalls)
}