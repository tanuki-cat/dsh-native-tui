/**
 * Recover MCP servers that restarted without closing their transport.
 *
 * The core manager sees a connection only through its transport. A restarted
 * Streamable HTTP server keeps the old connection object alive, so its tools
 * stay registered and every call fails. A connection-class tool failure is the
 * only observable signal: restart the server instance unless the core manager
 * is already reconnecting it. One attempt per server per window keeps a broken
 * server from being restarted on every call.
 *
 * @module dsh-native-tui/runtime/mcp-recovery
 */
import type { Context } from '@deepseek-ai/cordis'
import { debug } from '../debug.js'

/** Public prefix the MCP client gives every tool of one server. */
const TOOL_PREFIX = 'mcp__'
/** Minimum delay between automatic restarts for one server. */
const RETRY_WINDOW_MS = 30_000
/** Transport-owned failure phrasings; free text is deliberately absent. */
const CONNECTION_FAILURES: readonly RegExp[] = [
  /^Connection closed\b/iu,
  /\bserver is disconnected\b/iu,
  /^Error POSTing to endpoint\b/iu,
  /\bfetch failed\b/iu,
  /\bsocket hang up\b/iu,
  /\bECONNRESET\b/u,
  /\bECONNREFUSED\b/u,
  /\bEPIPE\b/u,
]

/** The manager surface recovery uses. */
interface McpManagerLike {
  list?(): readonly {
    readonly name: string
    readonly status: { readonly state: string }
  }[]
  restart(name: string): Promise<void>
}

/**
 * Read back the server a public MCP tool name belongs to.
 *
 * Server names are matched against the manager's own keys longest-first,
 * because a valid server name may itself contain `__`; the first-separator
 * fallback only covers a Host whose manager cannot list entries yet.
 * @param toolName - public tool name; anything outside the MCP namespace is ignored.
 * @param known - server names the manager currently lists.
 * @returns the server name, or undefined when the name is not one of theirs.
 */
function serverOfTool(toolName: string, known: readonly string[]): string | undefined {
  if (!toolName.startsWith(TOOL_PREFIX)) return undefined
  const matches = known
    .filter(name => toolName.startsWith(TOOL_PREFIX + name + '__'))
    .sort((left, right) => right.length - left.length)
  if (matches[0] !== undefined) return matches[0]
  const rest = toolName.slice(TOOL_PREFIX.length)
  const end = rest.indexOf('__')
  return end > 0 ? rest.slice(0, end) : undefined
}

/** Extract the failure message of one tool result. */
function failureMessage(result: unknown): string {
  const error = (result as { error?: { message?: unknown } } | undefined)?.error
  return error !== undefined && typeof error.message === 'string' ? error.message : ''
}

/** Decide whether one failed call proves the transport is gone. */
function isConnectionFailure(result: unknown, message: string): boolean {
  const code = (result as { error?: { info?: { code?: unknown } } } | undefined)?.error?.info?.code
  if (code === 'ConnectionClosed') return true
  return CONNECTION_FAILURES.some(pattern => pattern.test(message))
}

/** States the core manager is already resolving without outside help. */
function coreIsRecovering(state: string | undefined): boolean {
  return state === 'connecting' || state === 'reconnecting' || state === 'disabled' || state === 'waiting-credentials'
}

/**
 * Observe MCP tool failures and restart a server whose live instance is stale.
 *
 * A successful probe is not evidence that the live connection works: the
 * probe opens its own connection. Restart therefore keys on the failure and
 * the manager's live state, not on a probe result.
 * @param ctx - Host context that may carry the core `mcpManager` service.
 * @returns the disposer removing the observer.
 */
export function installMcpRecovery(ctx: Context): () => void {
  const manager = (): McpManagerLike | undefined =>
    (ctx as unknown as { get(name: string): unknown }).get('mcpManager') as McpManagerLike | undefined
  const lastAttempt = new Map<string, number>()
  const observe = (exec: unknown, result: unknown): void => {
    const toolName = (exec as { name?: unknown } | undefined)?.name
    if (typeof toolName !== 'string') return
    if ((result as { isError?: unknown } | undefined)?.isError !== true) return
    const message = failureMessage(result)
    if (!isConnectionFailure(result, message)) return
    const service = manager()
    if (service === undefined) return
    const views = service.list?.()
    const name = serverOfTool(toolName, views?.map(view => view.name) ?? [])
    if (name === undefined) return
    const state = views?.find(view => view.name === name)?.status.state
    if (coreIsRecovering(state)) return
    const now = Date.now()
    const previous = lastAttempt.get(name)
    if (previous !== undefined && now - previous < RETRY_WINDOW_MS) return
    lastAttempt.set(name, now)
    void (async () => {
      try {
        debug('mcp recovery: restarting ' + name + ' after a connection-class failure')
        await service.restart(name)
      }
      catch (error) {
        debug('mcp recovery: ' + name + ' restart failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
    })()
  }
  const on = (ctx as unknown as {
    on(event: string, callback: (...args: never[]) => void): () => void
  }).on('tools/result', observe as never)
  return () => on()
}
