/**
 * Recover MCP servers that restarted without closing their transport.
 *
 * The core manager sees a connection only through its transport. A restarted
 * Streamable HTTP server keeps the old connection object alive, so its tools
 * stay registered and every call fails. A run of connection-class tool failures
 * is the only observable signal: restart the server instance unless the core
 * manager is already reconnecting it. A tool's own network error arrives as the
 * same free text, so one failure is not enough — only a run with no answered
 * call in between (or the structured closed-connection code) restarts the
 * server, a run that stops advancing for one retry window is over, and one
 * attempt per server per window keeps a broken server from being restarted on
 * every call.
 *
 * @module dsh-native-tui/runtime/mcp-recovery
 */
import type { Context } from '@deepseek-ai/cordis'
import { debug } from '../debug.js'

/** Public prefix the MCP client gives every tool of one server. */
const TOOL_PREFIX = 'mcp__'
/** Minimum delay between automatic restarts for one server. */
export const RETRY_WINDOW_MS = 30_000
/**
 * Connection-class failures one server must show in a row before it is restarted.
 *
 * A tool owns its own network errors: an MCP server that fetches URLs reports
 * `fetch failed` for one unreachable target exactly as a dying transport does,
 * and both arrive as the same free-text failure. Requiring consecutive failures
 * with no answered call in between keeps one such report from killing a healthy
 * server's other tools, while a dead transport still fails every call it gets.
 * A streak also ages out after one retry window, so two unrelated failures
 * minutes apart do not add up to a restart. A structured closed-connection code
 * (`ConnectionClosed` or `MCP_CONNECTION_CLOSED`) needs no corroboration: no
 * tool body produces it.
 */
const REQUIRED_FAILURES = 2
/**
 * Leading context the Host adds before the transport's own message.
 *
 * Tool failures arrive as `MCP tool "<name>" failed: ...`, resource failures as
 * `MCP resources/read failed: ...`. The transport text is matched after this
 * prefix is removed, so prefixes cannot hide the first-word patterns below.
 */
const MCP_FAILURE_PREFIX = /^MCP .+ failed:\s*/u
/** Transport-owned failure phrasings; free text is deliberately absent. */
const CONNECTION_FAILURES: readonly RegExp[] = [
  /^Connection closed\b/iu,
  /\bserver is disconnected\b/iu,
  /^Error POSTing to endpoint\b/iu,
  /\bMCP transport closed\b/iu,
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
    readonly authorization?: { readonly phase: string }
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

/** Structured error code the MCP client assigns to a closed transport. */
function closedConnectionCode(result: unknown): boolean {
  const code = (result as { error?: { info?: { code?: unknown } } } | undefined)?.error?.info?.code
  return code === 'MCP_CONNECTION_CLOSED' || code === 'ConnectionClosed'
}

/** Remove the Host's failure prefix so first-word transport patterns still match. */
function transportMessage(message: string): string {
  return message.replace(MCP_FAILURE_PREFIX, '')
}

/** Decide whether one failed call looks like a transport failure. */
function isConnectionFailure(result: unknown, message: string): boolean {
  const transport = transportMessage(message)
  return closedConnectionCode(result) || CONNECTION_FAILURES.some(pattern => pattern.test(transport))
}

/** States the core manager is already resolving without outside help. */
function coreIsRecovering(state: string | undefined): boolean {
  return state === 'connecting' || state === 'reconnecting' || state === 'disabled' || state === 'waiting-credentials'
    || state === 'waiting-authorization'
}

/** Whether a Host OAuth attempt is still active. */
export function mcpAuthorizationInProgress(phase: string | undefined): boolean {
  return phase === 'starting' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
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
  /** Connection-class failures per server, with the time each streak last advanced. */
  const failureRun = new Map<string, { readonly count: number; readonly at: number }>()
  const observe = (exec: unknown, result: unknown): void => {
    const toolName = (exec as { name?: unknown } | undefined)?.name
    if (typeof toolName !== 'string' || !toolName.startsWith(TOOL_PREFIX)) return
    const failed = (result as { isError?: unknown } | undefined)?.isError === true
    // A working call only matters while a streak is open; it needs no lookup.
    if (!failed && failureRun.size === 0) return
    const service = manager()
    if (service === undefined) return
    const views = service.list?.()
    const name = serverOfTool(toolName, views?.map(view => view.name) ?? [])
    if (name === undefined) return
    const message = failed ? failureMessage(result) : ''
    // A call the server answered — even with a business error — proves the
    // transport is alive, so any non-connection result ends the streak.
    if (!failed || !isConnectionFailure(result, message)) {
      failureRun.delete(name)
      return
    }
    const now = Date.now()
    const previousRun = failureRun.get(name)
    // One retry window without another failure ends the streak: two incidents
    // minutes apart are not evidence of one dying transport.
    const streak = previousRun !== undefined && now - previousRun.at < RETRY_WINDOW_MS
      ? previousRun.count
      : 0
    const run = closedConnectionCode(result) ? REQUIRED_FAILURES : streak + 1
    failureRun.set(name, { count: run, at: now })
    if (run < REQUIRED_FAILURES) return
    const view = views?.find(view => view.name === name)
    // While the core reconnects on its own, its failures are not ours to count.
    if (coreIsRecovering(view?.status.state) || mcpAuthorizationInProgress(view?.authorization?.phase)) {
      failureRun.delete(name)
      return
    }
    const previous = lastAttempt.get(name)
    if (previous !== undefined && now - previous < RETRY_WINDOW_MS) return
    lastAttempt.set(name, now)
    failureRun.delete(name)
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
