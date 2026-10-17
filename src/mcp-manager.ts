/**
 * Dynamic MCP server manager for the terminal bundle.
 * Servers are stored as the mcp-manager settings object; each configured entry
 * is materialized as an official mcp-client Loader row and removed on dispose.
 * The manager reconciles that live row set against settings, so adding,
 * editing, or removing a server takes effect without restarting the terminal.
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
 * is active; `disconnected` means it had registered tools and then lost them,
 * which mcp-client does when reconnect is disabled or its attempt budget runs
 * out. A server that never registers tools stays `connected` while its row is
 * active, because tool absence alone cannot prove a dropped connection.
 */
export interface McpServerState {
  readonly status: 'starting' | 'connected' | 'disconnected' | 'error'
  readonly error?: string
}

/** Shared runtime status exposed to the TUI. */
export interface McpManagerStatus {
  snapshot(): Record<string, McpServerState>
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
  /** Tool names this server had registered at the last observation. */
  tools: Set<string>
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
/**
 * Loader.create cannot run inside the Manager's own config reload, so the first
 * pass waits for activation to return instead of loading synchronously.
 */
const INITIAL_LOAD_DELAY_MS = 250

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

/** Tool-name prefix mcp-client registerers for one server, e.g. `mcp__demo__echo`. */
function toolNamePrefix(serverName: string): string {
  return 'mcp__' + serverName + '__'
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
  const loader = (ctx as unknown as { loader?: LoaderLike }).loader
  if (loader === undefined) throw new Error('mcp-manager requires the Loader service')
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
  const status: McpManagerStatus = { snapshot: () => Object.fromEntries(states) }
  const withdraw = (ctx as unknown as { provide(name: string, value: unknown): () => void }).provide('mcpManagerStatus', status)
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  /** Tool names currently registered for one server, read from the tool registry. */
  const liveTools = (serverName: string): Set<string> => {
    const registry = toolRegistry()
    if (registry === undefined) return new Set()
    const prefix = toolNamePrefix(serverName)
    try {
      return new Set(registry.schemas().map(schema => schema.name).filter(toolName => toolName.startsWith(prefix)))
    }
    catch {
      // A failed status probe must never fail the connection it describes.
      return new Set()
    }
  }

  const removeRow = (entry: Entry): void => {
    try { loader.remove(entry.id) }
    catch { /* A row may already have been removed by a reload. */ }
  }

  const loadOne = async (serverName: string, raw: unknown, fingerprint: string): Promise<void> => {
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
        removeRow({ id: entryId, fingerprint, tools: new Set() })
        return
      }
      entries.set(serverName, { id: entryId, fingerprint, tools: liveTools(serverName) })
      states.set(serverName, { status: 'connected' })
    }
    catch (error) {
      if (created) removeRow({ id: entryId, fingerprint, tools: new Set() })
      states.set(serverName, { status: 'error', error: describeFailure(error) })
    }
  }

  /** Add, reload, or drop rows so the live set matches the stored configuration. */
  const reconcile = async (): Promise<void> => {
    if (disposed) return
    const desired = readServers()
    for (const [serverName, entry] of [...entries]) {
      if (Object.hasOwn(desired, serverName)) continue
      entries.delete(serverName)
      states.delete(serverName)
      removeRow(entry)
    }
    for (const [serverName, raw] of Object.entries(desired)) {
      if (disposed) return
      const fingerprint = JSON.stringify(raw)
      const existing = entries.get(serverName)
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) continue
        entries.delete(serverName)
        removeRow(existing)
      }
      await loadOne(serverName, raw, fingerprint)
    }
  }

  // Serialize passes: a reload that lands while one is running must not
  // interleave Loader.create/remove for the same server.
  const scheduleReconcile = (): void => {
    queue = queue.then(reconcile).catch(() => { /* Keep the next pass usable. */ })
  }

  /**
   * mcp-client keeps a server's tools registered while it reconnects and
   * unregisters them when it gives up, so a previously registered set that went
   * empty is the observable signal that the connection was lost.
   */
  const syncToolState = (): void => {
    for (const [serverName, entry] of entries) {
      const live = liveTools(serverName)
      if (live.size > 0) {
        entry.tools = live
        if (states.get(serverName)?.status !== 'connected') states.set(serverName, { status: 'connected' })
        continue
      }
      if (entry.tools.size > 0) {
        entry.tools = live
        states.set(serverName, { status: 'disconnected', error: 'connection lost; the server tools are no longer registered' })
      }
    }
  }

  setTimeout(() => { scheduleReconcile() }, INITIAL_LOAD_DELAY_MS)
  const offSettings = events.on('settings/document-updated', (ns: unknown) => {
    if (ns === 'mcp-manager') scheduleReconcile()
  })
  const offTools = events.on('tools/change', () => { syncToolState() })

  ctx.effect(() => () => {
    disposed = true
    offSettings()
    offTools()
    withdraw()
    for (const [serverName, entry] of [...entries]) {
      entries.delete(serverName)
      removeRow(entry)
    }
  })
}
