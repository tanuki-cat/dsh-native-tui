import { describe, expect, it } from 'vitest'
import { apply, type McpManagerStatus } from '../src/mcp-manager.js'

type Listener = (...args: unknown[]) => void

interface HarnessOptions {
  servers: () => Record<string, unknown>
  /** Fails the next N row creations, as a host that is not listening yet would. */
  createErrors?: () => Error | undefined
  createError?: Error
  fiberError?: Error
  tools?: () => readonly { name: string }[]
  /** When false, ctx.get('tools') resolves nothing, as in a composition without the registry. */
  toolRegistry?: boolean
}

function harness(options: HarnessOptions) {
  const created: { id: string; name: string; config: Record<string, unknown> }[] = []
  const removed: string[] = []
  /** Every row creation, including the ones that fail, so retries stay countable. */
  let createCalls = 0
  const listeners = new Map<string, Listener[]>()
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
    on: (event: string, callback: Listener) => {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event)
        if (current !== undefined) current.splice(current.indexOf(callback), 1)
      }
    },
    get: (name: string) => {
      if (name !== 'tools' || options.toolRegistry === false) return undefined
      // Returning an empty schema list stands in for "the server registered nothing".
      return { schemas: () => (options.tools === undefined ? [] : options.tools()) }
    },
    loader: {
      create: async (row: { id: string; name: string; config: Record<string, unknown> }) => {
        createCalls += 1
        const error = options.createErrors?.() ?? options.createError
        if (error !== undefined) throw error
        created.push(row)
        return row.id
      },
      resolve: () => ({ fiber: { state: 2, await: async () => { if (options.fiberError !== undefined) throw options.fiberError } } }),
      remove: (id: string) => { removed.push(id) },
    },
  }
  // Cordis throws when an uninjected service is read as a property; reproduce
  // that so any regression to `ctx.tools` fails here instead of only in a live Host.
  Object.defineProperty(ctx, 'tools', {
    get() { throw new Error('cannot get property "tools" without inject') },
    configurable: true,
  })
  return {
    ctx,
    created,
    removed,
    get createCalls() { return createCalls },
    emit: (event: string, ...args: unknown[]) => {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(...args)
    },
    get status() { return status?.snapshot() },
    get manager() {
      if (status === undefined) throw new Error('mcpManagerStatus was never provided')
      return status
    },
    cleanup: () => cleanup?.(),
    run: () => apply(ctx as never, { servers: { get: options.servers } } as never),
  }
}

const settle = (ms = 400): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const stdio = (command: string): Record<string, unknown> => ({ transport: 'stdio', command, args: [] })

describe('mcp-manager', () => {
  it('materializes each configured server as an mcp-client row and removes it on dispose', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }) })
    h.run()
    await settle()
    expect(h.created).toEqual([{
      id: 'native-tui-mcp-demo',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { transport: 'stdio', command: 'false', args: [], serverName: 'demo', failOnStartupError: true },
    }])
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
  })

  it('removes the loader row when fiber activation fails', async () => {
    const h = harness({ servers: () => ({ broken: stdio('false') }), fiberError: new Error('activation failed') })
    h.run()
    await settle()
    expect(h.status).toEqual({ broken: { status: 'error', error: 'activation failed' } })
    expect(h.removed).toEqual(['native-tui-mcp-broken'])
    h.cleanup()
  })

  it('exposes a failed connection instead of silently swallowing it', async () => {
    const h = harness({ servers: () => ({ broken: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } }), createError: new Error('connection refused') })
    h.run()
    await settle()
    expect(h.status).toEqual({ broken: { status: 'error', error: 'connection refused' } })
    h.cleanup()
  })

  it('reads the tool registry through ctx.get instead of an uninjected property', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    expect(h.removed).toEqual([])
    h.cleanup()
  })

  it('stays connected when no tool registry is available', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), toolRegistry: false })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    expect(h.removed).toEqual([])
    h.cleanup()
  })

  it('keeps the connection when the tool registry probe throws', async () => {
    const h = harness({
      servers: () => ({ demo: stdio('false') }),
      tools: () => { throw new Error('registry probing failed') },
    })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    expect(h.removed).toEqual([])
    h.cleanup()
  })

  it('loads a server added through settings without a restart', async () => {
    let servers: Record<string, unknown> = {}
    const h = harness({ servers: () => servers })
    h.run()
    await settle()
    expect(h.created).toEqual([])

    servers = { demo: stdio('false') }
    h.emit('settings/document-updated', 'mcp-manager', 1)
    await settle(150)
    expect(h.created.map(row => row.id)).toEqual(['native-tui-mcp-demo'])
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('removes a server deleted through settings', async () => {
    let servers: Record<string, unknown> = { demo: stdio('false') }
    const h = harness({ servers: () => servers })
    h.run()
    await settle()

    servers = {}
    h.emit('settings/document-updated', 'mcp-manager', 2)
    await settle(150)
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
    expect(h.status).toEqual({})
    h.cleanup()
  })

  it('reloads a server whose configuration changed', async () => {
    let servers: Record<string, unknown> = { demo: stdio('first') }
    const h = harness({ servers: () => servers })
    h.run()
    await settle()

    servers = { demo: stdio('second') }
    h.emit('settings/document-updated', 'mcp-manager', 3)
    await settle(150)
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
    expect(h.created.map(row => row.config.command)).toEqual(['first', 'second'])
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('ignores settings updates for other namespaces', async () => {
    let servers: Record<string, unknown> = {}
    const h = harness({ servers: () => servers })
    h.run()
    await settle()

    servers = { demo: stdio('false') }
    h.emit('settings/document-updated', 'agent-loop', 1)
    await settle(150)
    expect(h.created).toEqual([])
    h.cleanup()
  })

  it('marks a server disconnected when its registered tools disappear', async () => {
    let tools: { name: string }[] = [{ name: 'mcp__demo__echo' }]
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => tools })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })

    tools = []
    h.emit('tools/change')
    expect(h.status).toEqual({
      demo: { status: 'disconnected', error: 'connection lost; the server tools are no longer registered' },
    })
    h.cleanup()
  })

  it('reports a reconnected server once its tools are registered again', async () => {
    let tools: { name: string }[] = []
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => tools })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })

    tools = [{ name: 'mcp__demo__echo' }]
    h.emit('tools/change')
    tools = []
    h.emit('tools/change')
    expect(h.status?.demo?.status).toBe('disconnected')

    tools = [{ name: 'mcp__demo__echo' }]
    h.emit('tools/change')
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('ignores tools registered by other servers', async () => {
    const h = harness({
      servers: () => ({ demo: stdio('false') }),
      tools: () => [{ name: 'mcp__other__echo' }],
    })
    h.run()
    await settle()
    h.emit('tools/change')
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('does not revive a faulted server when an unrelated tools/change arrives', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    h.emit('tools/result', { name: 'mcp__demo__echo' }, { isError: true, error: { message: 'Connection closed' } })
    expect(h.status?.demo?.status).toBe('disconnected')

    // The stale registration is still listed, so a naive "tools are present"
    // check would report the server as healthy again.
    h.emit('tools/change')
    expect(h.status?.demo?.status).toBe('disconnected')
    h.cleanup()
  })

  it('keeps the connection when the registry probe throws during a change', async () => {
    let fail = false
    const h = harness({
      servers: () => ({ demo: stdio('false') }),
      tools: () => {
        if (fail) throw new Error('registry probing failed')
        return [{ name: 'mcp__demo__echo' }]
      },
    })
    h.run()
    await settle()
    fail = true
    h.emit('tools/change')
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('marks a server disconnected when a tool call reports a lost connection', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })

    h.emit('tools/result', { name: 'mcp__demo__echo' }, {
      isError: true,
      error: { message: 'mcp-client(demo): server is disconnected' },
    })
    expect(h.status?.demo?.status).toBe('disconnected')
    expect(h.status?.demo?.error).toContain('server is disconnected')
    h.cleanup()
  })

  it('rebuilds the client row after a connection failure and reports the reconnected server', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()
    expect(h.created).toHaveLength(1)

    h.emit('tools/result', { name: 'mcp__demo__echo' }, { isError: true, error: { message: 'Connection closed' } })
    // The failure is visible immediately; the rebuild follows on the backoff.
    expect(h.status?.demo?.status).toBe('disconnected')
    await settle(700)
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
    expect(h.created).toHaveLength(2)
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('clears the reconnect budget once a call succeeds again', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    h.emit('tools/result', { name: 'mcp__demo__echo' }, { isError: true, error: { message: 'socket hang up' } })
    expect(h.status?.demo?.status).toBe('disconnected')
    h.emit('tools/result', { name: 'mcp__demo__echo' }, { isError: false })
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('ignores failures that are not connection errors', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    h.emit('tools/result', { name: 'mcp__demo__echo' }, {
      isError: true,
      error: { message: 'Tool "echo" returned an invalid MCP result: bad arguments' },
    })
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('does not treat ordinary failure wording as a lost connection', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    // Both phrases appear in ordinary tool output; neither proves the
    // transport is gone, so the connection must survive untouched.
    for (const message of ['Error: command terminated with exit code 1', 'not connected to the requested database']) {
      h.emit('tools/result', { name: 'mcp__demo__echo' }, { isError: true, error: { message } })
      expect(h.status).toEqual({ demo: { status: 'connected' } })
    }
    expect(h.removed).toEqual([])
    h.cleanup()
  })

  it('treats the SDK ConnectionClosed code as a lost connection regardless of wording', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    h.emit('tools/result', { name: 'mcp__demo__echo' }, {
      isError: true,
      error: { message: 'unexpected wording', info: { name: 'SdkError', code: 'ConnectionClosed' } },
    })
    expect(h.status?.demo?.status).toBe('disconnected')
    h.cleanup()
  })

  it('keeps a never-tool-registering server connected when its tools reappear', async () => {
    let tools: { name: string }[] = []
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => tools })
    h.run()
    await settle()
    expect(h.status).toEqual({ demo: { status: 'connected' } })

    tools = [{ name: 'mcp__demo__echo' }]
    h.emit('tools/change')
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('ignores tool failures from servers the manager does not own', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    h.emit('tools/result', { name: 'mcp__other__echo' }, { isError: true, error: { message: 'Connection closed' } })
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('keeps retrying a server that fails to start, reporting the live error', async () => {
    const h = harness({
      servers: () => ({ demo: stdio('false') }),
      createErrors: () => new Error('connection refused'),
    })
    h.run()
    await settle()
    const first = h.createCalls
    expect(first).toBe(1)
    expect(h.status?.demo?.status).toBe('error')
    expect(h.status?.demo?.error).toContain('connection refused')

    // The automatic reconnect keeps landing on the same failure rather than
    // freezing the row in its first error.
    await settle(1600)
    expect(h.createCalls).toBeGreaterThan(first)
    expect(h.status?.demo?.status).toBe('error')
    h.cleanup()
  })

  it('rebuilds a server on demand through the status service', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }), tools: () => [{ name: 'mcp__demo__echo' }] })
    h.run()
    await settle()

    await h.manager.reload('demo')
    expect(h.removed).toEqual(['native-tui-mcp-demo'])
    expect(h.created).toHaveLength(2)
    expect(h.status).toEqual({ demo: { status: 'connected' } })
    h.cleanup()
  })

  it('rejects a reload of an unconfigured server without creating a row', async () => {
    const h = harness({ servers: () => ({ demo: stdio('false') }) })
    h.run()
    await settle()

    await expect(h.manager.reload('missing')).rejects.toThrow('no stored configuration')
    expect(h.created).toHaveLength(1)
    h.cleanup()
  })

  it('resets the reconnect budget on a manual reload', async () => {
    const h = harness({
      servers: () => ({ demo: stdio('false') }),
      tools: () => [{ name: 'mcp__demo__echo' }],
      createErrors: () => new Error('connection refused'),
    })
    h.run()
    await settle()
    expect(h.status?.demo?.status).toBe('error')

    await h.manager.reload('demo')
    // The rebuild happens immediately rather than waiting out the backoff.
    const calls = h.createCalls
    expect(calls).toBeGreaterThan(1)
    h.cleanup()
  })
})
