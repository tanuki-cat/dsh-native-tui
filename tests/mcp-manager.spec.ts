import { describe, expect, it } from 'vitest'
import { apply } from '../src/mcp-manager.js'

function harness(servers: Record<string, unknown>) {
  const created: { id: string; name: string; config: Record<string, unknown> }[] = []
  const removed: string[] = []
  let cleanup: (() => void) | undefined
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
    loader: {
      create: async (options: { id: string; name: string; config: Record<string, unknown> }) => {
        created.push(options)
        return options.id
      },
      remove: (id: string) => { removed.push(id) },
    },
  }
  return {
    ctx,
    created,
    removed,
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
      config: { transport: 'stdio', command: 'false', args: [], serverName: 'demo' },
    }])
    h.cleanup()
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
  })
})
