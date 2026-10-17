/**
 * Dynamic MCP server manager for the terminal bundle.
 * Servers are stored as the mcp-manager settings object; each configured entry
 * is materialized as an official mcp-client Loader row and removed on dispose.
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

/** Settings schema; mcp-client owns transport-level validation. */
export const Config = z.object({
  servers: z.dict(z.any()).default({}).volatile(),
}) as unknown as z<Config>

interface LoaderLike {
  create(options: { id: string; name: string; config: Record<string, unknown> }): Promise<string>
  remove(id: string): void
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u

/**
 * Materialize one mcp-client row per configured server.
 * @param ctx - Host context carrying the Loader.
 * @param config - serverName-keyed MCP client configurations.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => {
    const scoped = child as unknown as { settings: { configure(options: Record<string, unknown>, fiber: unknown): () => void } }
    child.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber))
  })
  const loader = (ctx as unknown as { loader?: LoaderLike }).loader
  if (loader === undefined) throw new Error('mcp-manager requires the Loader service')
  const configured = typeof (config.servers as unknown as { get?: () => McpServers }).get === 'function'
    ? (config.servers as unknown as { get(): McpServers }).get()
    : config.servers as unknown as McpServers
  const ids = new Set<string>()
  let disposed = false
  const load = async (): Promise<void> => {
    for (const [serverName, raw] of Object.entries(configured ?? {})) {
      if (disposed) return
      if (!SERVER_NAME.test(serverName)) continue
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entryId = 'native-tui-mcp-' + serverName
      try {
        await loader.create({
          id: entryId,
          name: '@deepseek-ai/dsh-mcp-client',
          config: { ...raw, serverName },
        })
        if (disposed) {
          loader.remove(entryId)
          return
        }
        ids.add(entryId)
      }
      catch {
        // A failed server remains configured; its next Manager reload retries it.
      }
    }
  }
  // Loader.create cannot run inside the Manager's own config reload. Activation
  // returns first; rows load immediately after it, so /mcp saves do not block.
  setTimeout(() => { void load() }, 250)
  ctx.effect(() => () => {
    disposed = true
    for (const id of ids) {
      try { loader.remove(id) }
      catch { /* A row may already have been removed by a reload. */ }
    }
  })
}
