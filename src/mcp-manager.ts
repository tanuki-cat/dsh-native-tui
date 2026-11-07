/**
 * Dynamic MCP server manager for the terminal bundle.
 * Servers are stored as the mcp-manager settings object; each configured entry
 * is materialized as an official mcp-client Loader row and removed on dispose.
 * The manager reconciles that live row set against settings, so adding,
 * editing, or removing a server takes effect without restarting the terminal.
 *
 * mcp-client notices a lost connection only through its transport close
 * signal, which a restarted Streamable HTTP server never sends: its tools stay
 * registered and every call fails with the connection error. The manager
 * therefore treats a connection-class tool failure as the disconnect signal,
 * rebuilds the row itself, and exposes the same rebuild as an explicit reload.
 * @module dsh-native-tui/mcp-manager
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin name used by Loader diagnostics. */
export const name = 'mcp-manager'

/** Required Loader and settings services. */
export const inject = ['loader', 'settings']

/** One configured MCP server, keyed by its unique serverName. */
export type McpServers = Record<string, Record<string, unknown>>

/** Manager configuration. */
export interface Config {
  servers: Volatile<McpServers>
}

/**
 * Runtime state of one configured MCP server. `connected` means its client row
 * is active; `disconnected` means its connection is known to be gone — either
 * mcp-client unregistered the server's tools, or a tool call failed with a
 * connection error. A server that never registers tools stays `connected`
 * while its row is active, because tool absence alone cannot prove a dropped
 * connection.
 */
export interface McpServerState {
  readonly status: 'starting' | 'connected' | 'disconnected' | 'error'
  readonly error?: string
}

/** Shared runtime status exposed to the TUI. */
export interface McpManagerStatus {
  snapshot(): Record<string, McpServerState>
  /**
   * Tear down one server's client row and build it again from the stored
   * configuration, whether or not the manager still believes it is connected.
   * The rebuild resets the reconnect budget, so this is the manual escape from
   * an exhausted or disabled reconnect policy.
   * @param serverName - configured server to rebuild.
   * @returns settlement of the rebuild; a connection failure is reported
   * through {@link snapshot} rather than rejected, so this settles only for an
   * unreadable configuration.
   */
  reload(serverName: string): Promise<void>
}

/** Settings schema; mcp-client owns transport-level validation. */
export const Config = z.object({
  servers: z.dict(z.any()).default({}).volatile(),
}) as unknown as z<Config>

interface LoaderLike {
  create(options: { id: string; name: string; config: Record<string, unknown> }): Promise<string>
  resolve(id: string): { readonly fiber?: { state: number; await(): Promise<unknown> } }
  remove(id: string): void
}

interface Entry {
  readonly id: string
  /** Serialized settings the row was created from, used to detect edits. */
  readonly fingerprint: string
  /**
   * Tool names this server had registered at the last observation. `null`
   * means the registry could not be read, so nothing is known yet.
   */
  tools: Set<string> | null
  /** Automatic reconnect attempts spent on the current outage. */
  attempts: number
  /**
   * Set once a tool call reports a connection failure. Such a row keeps its
   * registration until it is rebuilt, so `tools/change` would otherwise
   * mistake "the stale registration is still listed" for a healthy connection
   * and flip the state back. Only a completed call or a rebuild clears it.
   *
   * mcp-client unregistering tools is deliberately NOT this flag: that is its
   * own reconnect cycle, and re-registering them is real evidence of recovery.
   */
  faulted: boolean
  /** Most recent failure seen for this entry, kept for the give-up message. */
  lastError?: string
  /** Pending automatic reconnect, cleared once it fires or the entry goes away. */
  timer?: ReturnType<typeof setTimeout>
}

/** Shared empty result for a server that registered nothing; never mutated. */
const NO_TOOLS: Set<string> = new Set()

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
/**
 * Loader.create cannot run inside the Manager's own config reload, so the first
 * pass waits for activation to return instead of loading synchronously.
 */
const INITIAL_LOAD_DELAY_MS = 250
/** First automatic reconnect delay; doubles per consecutive attempt. */
const RECONNECT_INITIAL_DELAY_MS = 500
/** Automatic reconnect backoff ceiling. */
const RECONNECT_MAX_DELAY_MS = 30_000
/** Automatic reconnects before the manager stops and asks for an explicit reload. */
const RECONNECT_MAX_ATTEMPTS = 5
/** Public prefix mcp-client gives every tool of one server. */
const TOOL_PREFIX = 'mcp__'
/**
 * Messages the MCP SDK and the Node fetch stack produce for a transport that is
 * gone. A restarted server surfaces only through its calls, so this
 * classification is what separates "the server came back but rejected the
 * arguments" from "the server is not there any more".
 *
 * These are anchored, transport-owned phrasings. Free-text fragments are
 * deliberately absent: a tool whose own output says "command terminated" or
 * "not connected" is reporting a business failure, and treating that as a
 * disconnect would tear down a working connection.
 */
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

/**
 * Describe a thrown value for the status line. An Error with an empty message
 * would otherwise render as a blank failure, which hides the cause.
 * @param error - the caught value.
 * @returns a non-empty single-line description.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const label = error.name === 'Error' ? '' : error.name + ': '
    return label + (error.message === '' ? '(no message)' : error.message)
  }
  const text = String(error)
  return text === '' ? '(thrown ' + Object.prototype.toString.call(error) + ')' : text
}

/**
 * Read back the server a public MCP tool name belongs to.
 * @param toolName - public tool name; anything outside the MCP namespace is ignored.
 * @returns the server name, or undefined when the name is not one of ours.
 */
function serverOfTool(toolName: string): string | undefined {
  if (!toolName.startsWith(TOOL_PREFIX)) return undefined
  const rest = toolName.slice(TOOL_PREFIX.length)
  const end = rest.indexOf('__')
  return end > 0 ? rest.slice(0, end) : undefined
}

/**
 * Extract the failure message of one tool result, for connection classification.
 * @param result - the observed `tools/result` value.
 * @returns the message, or an empty string when the result carries none.
 */
function failureMessage(result: unknown): string {
  const error = (result as { error?: { message?: unknown } } | undefined)?.error
  return error !== undefined && typeof error.message === 'string' ? error.message : ''
}

/**
 * Decide whether one failed tool call proves the transport is gone.
 *
 * The SDK's own `ConnectionClosed` code is authoritative when present; the
 * message patterns only cover transports that report a bare fetch failure.
 * @param result - the observed `tools/result` value.
 * @param message - its extracted failure message.
 * @returns whether the failure is a connection loss rather than a call failure.
 */
function isConnectionFailure(result: unknown, message: string): boolean {
  const code = (result as { error?: { info?: { code?: unknown } } } | undefined)?.error?.info?.code
  if (code === 'ConnectionClosed') return true
  return CONNECTION_FAILURES.some(pattern => pattern.test(message))
}

/**
 * Materialize one mcp-client row per configured server and keep the set
 * reconciled with settings.
 * @param ctx - Host context carrying the Loader and tool registry.
 * @param config - serverName-keyed MCP client configurations.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => {
    const scoped = child as unknown as { settings: { configure(options: Record<string, unknown>, fiber: unknown): () => void } }
    child.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber))
  })
  const maybeLoader = (ctx as unknown as { loader?: LoaderLike }).loader
  if (maybeLoader === undefined) throw new Error('mcp-manager requires the Loader service')
  const loader: LoaderLike = maybeLoader
  const events = ctx as unknown as { on(event: string, callback: (...args: never[]) => void): () => void }
  // Read the optional tool registry through ctx.get: mcp-manager deliberately
  // does not inject 'tools' (state inspection must not gate activation), and
  // reading an uninjected service as a property throws instead of yielding
  // undefined under the Cordis context proxy.
  const toolRegistry = (): { schemas(): readonly { name: string }[] } | undefined =>
    (ctx as unknown as { get(name: string): { schemas(): readonly { name: string }[] } | undefined }).get('tools')
  const readServers = (): McpServers => {
    const source = config.servers as unknown as { get?: () => McpServers }
    return (typeof source.get === 'function' ? source.get() : config.servers as unknown as McpServers) ?? {}
  }
  const entries = new Map<string, Entry>()
  const states = new Map<string, McpServerState>()
  const status: McpManagerStatus = {
    snapshot: () => Object.fromEntries(states),
    reload: (serverName: string) => reloadOne(serverName),
  }
  const withdraw = (ctx as unknown as { provide(name: string, value: unknown): () => void }).provide('mcpManagerStatus', status)
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  /**
   * Every live MCP tool grouped by the server that registered it.
   *
   * `tools/change` fires for the whole registry, so one read serves every
   * configured server; asking per server made the observation O(servers × tools).
   * @returns live tool names by server, or undefined when the registry cannot answer.
   */
  const liveToolSets = (): Map<string, Set<string>> | undefined => {
    const registry = toolRegistry()
    if (registry === undefined) return undefined
    try {
      const byServer = new Map<string, Set<string>>()
      for (const schema of registry.schemas()) {
        const serverName = serverOfTool(schema.name)
        if (serverName === undefined) continue
        const tools = byServer.get(serverName)
        if (tools === undefined) byServer.set(serverName, new Set([schema.name]))
        else tools.add(schema.name)
      }
      return byServer
    }
    catch {
      // A failed status probe must never fail the connection it describes.
      return undefined
    }
  }

  /**
   * Tool names currently registered for one server.
   * @param serverName - configured server.
   * @returns the live tool set, or undefined when the registry cannot answer.
   */
  const liveTools = (serverName: string): Set<string> | undefined => {
    const byServer = liveToolSets()
    return byServer === undefined ? undefined : byServer.get(serverName) ?? NO_TOOLS
  }

  const removeRow = (entry: Entry): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    try { loader.remove(entry.id) }
    catch { /* A row may already have been removed by a reload. */ }
  }

  /** Forget one server completely, cancelling any reconnect it was waiting on. */
  const forget = (serverName: string): Entry | undefined => {
    const entry = entries.get(serverName)
    if (entry === undefined) return undefined
    entries.delete(serverName)
    removeRow(entry)
    return entry
  }

  /**
   * Queue one automatic rebuild of a server that is known to be down.
   * Attempts back off from {@link RECONNECT_INITIAL_DELAY_MS} and stop after
   * {@link RECONNECT_MAX_ATTEMPTS}, leaving the status explaining the way out.
   * @param serverName - configured server to reconnect.
   */
  function scheduleReconnect(serverName: string): void {
    if (disposed) return
    const entry = entries.get(serverName)
    if (entry === undefined || entry.timer !== undefined) return
    if (entry.attempts >= RECONNECT_MAX_ATTEMPTS) {
      const detail = entry.lastError === undefined ? '' : ': ' + entry.lastError
      states.set(serverName, {
        status: 'disconnected',
        error: 'gave up after ' + RECONNECT_MAX_ATTEMPTS + ' reconnect attempts' + detail + '; run /mcp reload ' + serverName,
      })
      return
    }
    entry.attempts += 1
    const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_INITIAL_DELAY_MS * 2 ** (entry.attempts - 1))
    const timer = setTimeout(() => {
      entry.timer = undefined
      queue = queue.then(() => reconnectOne(serverName)).catch(() => { /* Keep the next pass usable. */ })
    }, delayMs)
    // A pending retry must not keep the Host alive on its own.
    timer.unref?.()
    entry.timer = timer
  }

  /**
   * Rebuild one row so the reconnect budget survives a failed attempt.
   * @param serverName - configured server to rebuild.
   */
  async function reconnectOne(serverName: string): Promise<void> {
    if (disposed) return
    const entry = entries.get(serverName)
    if (entry === undefined) return
    const raw = readServers()[serverName]
    if (raw === undefined) return
    const attempts = entry.attempts
    forget(serverName)
    await loadOne(serverName, raw, JSON.stringify(raw), attempts)
  }

  /**
   * Create one client row and record what its activation says about the server.
   * @param serverName - configured server name.
   * @param raw - stored mcp-client configuration.
   * @param fingerprint - serialized form of `raw`, used to detect edits.
   * @param attempts - reconnect attempts already spent on the current outage.
   */
  async function loadOne(serverName: string, raw: unknown, fingerprint: string, attempts: number): Promise<void> {
    if (!SERVER_NAME.test(serverName) || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      states.set(serverName, { status: 'error', error: 'invalid server configuration' })
      return
    }
    const entryId = 'native-tui-mcp-' + serverName
    states.set(serverName, { status: 'starting' })
    let created = false
    try {
      await loader.create({
        id: entryId,
        name: '@deepseek-ai/dsh-mcp-client',
        config: { ...raw as Record<string, unknown>, serverName, failOnStartupError: true },
      })
      created = true
      const fiber = loader.resolve(entryId).fiber
      if (fiber === undefined) throw new Error('MCP client entry did not activate')
      await fiber.await()
      // Cordis FiberState.ACTIVE is 2; the enum is not exported at runtime.
      if (fiber.state !== 2) throw new Error('MCP client entry is not active')
      if (disposed) {
        removeRow({ id: entryId, fingerprint, tools: new Set(), attempts, faulted: false })
        return
      }
      // An unreadable registry here would otherwise seed an empty tool set and
      // make the first later observation look like a lost connection.
      entries.set(serverName, {
        id: entryId,
        fingerprint,
        tools: liveTools(serverName) ?? null,
        attempts: 0,
        faulted: false,
      })
      states.set(serverName, { status: 'connected' })
    }
    catch (error) {
      if (created) removeRow({ id: entryId, fingerprint, tools: new Set(), attempts, faulted: false })
      const message = describeFailure(error)
      states.set(serverName, { status: 'error', error: message })
      if (disposed) return
      // Keep the identity so a later attempt can still rebuild the row from the
      // same settings, and so the budget survives a failed startup.
      entries.set(serverName, { id: entryId, fingerprint, tools: new Set(), attempts, faulted: true, lastError: message })
      scheduleReconnect(serverName)
    }
  }

  /** Add, reload, or drop rows so the live set matches the stored configuration. */
  const reconcile = async (): Promise<void> => {
    if (disposed) return
    const desired = readServers()
    for (const serverName of [...entries.keys()]) {
      if (Object.hasOwn(desired, serverName)) continue
      forget(serverName)
      states.delete(serverName)
    }
    for (const [serverName, raw] of Object.entries(desired)) {
      if (disposed) return
      const fingerprint = JSON.stringify(raw)
      const existing = entries.get(serverName)
      if (existing !== undefined && existing.fingerprint === fingerprint) continue
      if (existing !== undefined) forget(serverName)
      await loadOne(serverName, raw, fingerprint, 0)
    }
  }

  // Serialize passes: a reload that lands while one is running must not
  // interleave Loader.create/remove for the same server.
  const scheduleReconcile = (): void => {
    queue = queue.then(reconcile).catch(() => { /* Keep the next pass usable. */ })
  }

  /**
   * Manual rebuild behind {@link McpManagerStatus.reload}. Chained onto the
   * shared queue *at call time*, so two concurrent reloads run in sequence
   * rather than both hanging off the same predecessor.
   * @param serverName - configured server to rebuild.
   */
  function reloadOne(serverName: string): Promise<void> {
    const run = queue.then(async () => {
      if (disposed) return
      const raw = readServers()[serverName]
      if (raw === undefined) throw new Error('no stored configuration for MCP server "' + serverName + '"')
      forget(serverName)
      // A manual reload always restarts the budget: the operator asked for it.
      await loadOne(serverName, raw, JSON.stringify(raw), 0)
    })
    queue = run.catch(() => { /* Keep the next pass usable. */ })
    return run
  }

  /**
   * mcp-client keeps a server's tools registered while it reconnects and
   * unregisters them when it gives up, so a previously registered set that went
   * empty is the observable signal that the connection was lost.
   *
   * Seeing the tools again is NOT proof of a healthy connection: a row that a
   * failed call already marked as faulted is still registered until it is
   * rebuilt, so its stale tools stay listed the whole time. Only a completed
   * call or a successful rebuild clears the fault.
   */
  const syncToolState = (): void => {
    const byServer = liveToolSets()
    // An unreadable registry proves nothing; keep whatever we already believe.
    if (byServer === undefined) return
    for (const [serverName, entry] of entries) {
      const live = byServer.get(serverName) ?? NO_TOOLS
      if (live.size > 0) {
        entry.tools = live
        if (entry.faulted) continue
        entry.attempts = 0
        entry.lastError = undefined
        if (states.get(serverName)?.status !== 'connected') states.set(serverName, { status: 'connected' })
        continue
      }
      // A server that never registered tools stays connected: absence alone
      // proves nothing (see McpServerState). A null previous set is unknown too.
      // This path is mcp-client's own reconnect cycle, so it does not raise the
      // fault flag; re-registering the tools is genuine recovery evidence.
      if (entry.tools !== null && entry.tools.size > 0) {
        entry.tools = live
        states.set(serverName, { status: 'disconnected', error: 'connection lost; the server tools are no longer registered' })
        scheduleReconnect(serverName)
      }
    }
  }

  /**
   * Learn liveness from tool outcomes. mcp-client cannot see a restarted
   * Streamable HTTP server, so a call that fails with a connection error is the
   * only evidence available that the row is dead; a completed call is the
   * strongest evidence available that it is alive.
   * @param exec - the dispatched call.
   * @param result - its normalized outcome.
   */
  const observeToolResult = (exec: unknown, result: unknown): void => {
    const toolName = (exec as { name?: unknown } | undefined)?.name
    if (typeof toolName !== 'string') return
    const serverName = serverOfTool(toolName)
    if (serverName === undefined) return
    const entry = entries.get(serverName)
    if (entry === undefined) return
    if ((result as { isError?: unknown } | undefined)?.isError !== true) {
      entry.faulted = false
      entry.attempts = 0
      entry.lastError = undefined
      if (states.get(serverName)?.status !== 'connected') states.set(serverName, { status: 'connected' })
      return
    }
    const message = failureMessage(result)
    if (!isConnectionFailure(result, message)) return
    const error = message.slice(0, 160)
    entry.tools = new Set()
    entry.faulted = true
    entry.lastError = error
    states.set(serverName, { status: 'disconnected', error })
    scheduleReconnect(serverName)
  }

  setTimeout(() => { scheduleReconcile() }, INITIAL_LOAD_DELAY_MS)
  const offSettings = events.on('settings/document-updated', (ns: unknown) => {
    if (ns === 'mcp-manager') scheduleReconcile()
  })
  const offTools = events.on('tools/change', () => { syncToolState() })
  const offResults = events.on('tools/result', (exec: unknown, result: unknown) => { observeToolResult(exec, result) })

  ctx.effect(() => () => {
    disposed = true
    offSettings()
    offTools()
    offResults()
    withdraw()
    for (const serverName of [...entries.keys()]) forget(serverName)
  })
}
