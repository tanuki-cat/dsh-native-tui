import { describe, expect, it } from 'vitest'
import { apply, type McpManagerStatus } from '../src/mcp-manager.js'

function harness(servers: Record<string, unknown>, createError?: Error) {
  const created: { id: string; name: string; config: Record<string, unknown> }[] = []
  const removed: string[] = []
  let cleanup: (() => void) | undefined
  let status: McpManagerStatus | undefined
  const ctx = {
    fiber: {},
    inject: (_services: readonly string[], callback: (child: unknown) => void) => {
      callback({
        effect: (run: () => () => void) => {
          run()
        },
        settings: { configure: () => () => {} },
      })
    },
    effect: (run: () => () => void) => {
      cleanup = run()
    },
    provide: (_name: string, value: unknown) => {
      status = value as McpManagerStatus
      return () => {}
    },
    loader: {
      create: async (options: { id: string; name: string; config: Record<string, unknown> }) => {
        if (createError !== undefined) throw createError
        created.push(options)
        return options.id
      },
      resolve: () => ({ fiber: { state: 2, await: async () => {} } }),
      remove: (id: string) => { removed.push(id) },
    },
  }
  return {
    ctx,
    created,
    removed,
    get status() { return status?.snapshot() },
    cleanup: () => cleanup?.(),
    run: (config: unknown) => apply(ctx as never, config as never),
  }
}

describe('mcp-manager', () => {
  it('materializes each configured server as an mcp-client row and removes it on dispose', async () => {
    const h = harness({})
    h.run({ servers: { get: () => ({ demo: { transport: 'stdio', command: 'false', args: [] } }) } })
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(h.created).toEqual([{
      id: 'native-tui-mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'stdio', command: 'false', args: [], serverName: 'demo', failOnStartupError: true },
    }])
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
  })

  it('exposes a failed connection instead of silently swallowing it', async () => {
    const h = harness({}, new Error('connection refused'))
    h.run({ servers: { get: () => ({ broken: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } }) } })
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(h.status).toEqual({ broken: { status: 'error', error: 'connection refused' } })
    h.cleanup()
  })
})
