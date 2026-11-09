import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ptcCallLine } from './tool-preview.js'
import { toolLabel } from './tool-output.js'

/** Exact-call arguments for approval previews; unmatched requests never borrow a nearby call. */
export function approvalArguments(events: readonly unknown[], name: string, callId: string | undefined): string | undefined {
  if (callId === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: Record<string, unknown> } | undefined
    const data = event?.data
    if (data === undefined || data === null || data.name !== name) continue
    const matches = event?.type === 'tool/call' ? data.callId === callId
      : event?.type === 'tool/ptc-dispatch-start' || event?.type === 'tool/ptc-dispatch' ? data.subCallId === callId : false
    if (!matches) continue
    if (typeof data.arguments === 'string') return data.arguments
    try { return JSON.stringify(data.arguments) }
    catch { return undefined }
  }
  return undefined
}

/** JSON preserves control characters and multiline commands visibly without executing terminal escapes. */
export function approvalRequestDetails(name: string, callId: string | undefined, reason: string | undefined, args: string | undefined, cwd?: string): string {
  let value: unknown = args
  if (args !== undefined) {
    try { value = JSON.parse(args) }
    catch { /* Preserve malformed arguments as literal input. */ }
  }
  return JSON.stringify({ tool: name, callId, sessionCwd: cwd, reason, arguments: value ?? '(arguments unavailable for this request)' }, null, 2)
}

/** Describe only the decision actually returned for this exact pending request. */
export function approvalReceipt(name: string, args: string | undefined, outcome: ApprovalOutcome): {
  readonly tone: 'success' | 'warning' | 'info'
  readonly text: string
} {
  const action = args === undefined ? toolLabel(name) : ptcCallLine(name, args)
  if (outcome === 'allowed-once') return { tone: 'success', text: 'You approved ' + action + ' this time' }
  if (outcome === 'rejected') return { tone: 'warning', text: 'You rejected ' + action }
  return { tone: 'info', text: 'Approval cancelled for ' + action }
}
