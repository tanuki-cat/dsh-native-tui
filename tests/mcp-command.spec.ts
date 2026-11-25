import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { mcpCommand } from '../src/ui/commands/mcp.js'
import type { McpOAuthAttemptView } from '../src/ui/commands/services.js'
import { showChoice, showTextInput } from '../src/ui/dialogs.js'

vi.mock('../src/ui/dialogs.js', () => ({
  showChoice: vi.fn(),
  showSearchChoice: vi.fn(),
  showTextInput: vi.fn(),
  showMultilineInput: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

/** One recorded notice. */
interface Notice {
  readonly tone: string
  readonly text: string
}

/** A context with an ANSI palette, so a colored row would be visible in output. */
function contextOf(services: Record<string, unknown>, signal = new AbortController().signal): CommandContext & { notices: Notice[] } {
  const notices: Notice[] = []
  const color = (open: string) => (value: string) => open + value + '\u001B[0m'
  const ctx = {
    notices,
    host: { get: (name: string) => services[name], on: () => () => undefined, commands: { list: () => [] } },
    config: { cwd: '/tmp' },
    palette: {
      dim: color('\u001B[2m'),
      bold: color('\u001B[1m'),
      success: color('\u001B[32m'),
      warning: color('\u001B[33m'),
      error: color('\u001B[31m'),
    },
    tui: {},
    active: { id: 'session-1', agent: { session: { header: {} } } },
    signal,
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: {},
    setContextWindow: () => undefined,
    readContext: () => ({ metrics: { turns: 0, steps: 0, totalTokens: 0 }, breakdown: undefined }),
    persistSelection: async () => undefined,
  }
  return ctx as unknown as CommandContext & { notices: Notice[] }
}

/** Settings stub whose describe revision advances after the first read. */
function settingsOf(servers: Record<string, unknown>, revisions: readonly number[]) {
  const writes: { readonly ops: readonly unknown[]; readonly revision: number | undefined }[] = []
  let reads = 0
  return {
    writes,
    settings: {
      describe: () => {
        const revision = revisions[Math.min(reads, revisions.length - 1)]!
        reads += 1
        return [{ ns: 'mcp-manager', value: { servers }, schema: {}, revision, applies: 'live' as const, autoGenerate: true, secrets: [] }]
      },
      update: async () => undefined,
      mutate: async (_ns: string, ops: readonly unknown[], revision?: number) => { writes.push({ ops, revision }) },
    },
  }
}

const status = { state: 'waiting-authorization', reason: 'missing' }

describe('/mcp list output', () => {
  it('prints plain status text without dead ANSI coloring', async () => {
    const { settings } = settingsOf({ demo: { transport: 'stdio', command: 'npx' } }, [1])
    const ctx = contextOf({
      settings,
      mcpManager: { list: () => [{ name: 'demo', configured: true, status: { state: 'connected', toolCount: 2 } }] },
    })
    await mcpCommand(ctx, 'list')
    const text = ctx.notices.map(notice => notice.text).join('\n')
    expect(text).toContain('connected · 2 tools')
    expect(text).not.toContain('\u001B')
  })
})

describe('/mcp auth timeout', () => {
  it('cancels and reports after five minutes', async () => {
    vi.useFakeTimers()
    let attempt: McpOAuthAttemptView = { id: 'a', phase: 'waiting-browser', authorizationUrl: 'http://localhost/a' }
    const cancelAuthorization = vi.fn(async () => { attempt = { id: 'a', phase: 'cancelled' } })
    const { settings } = settingsOf({ demo: { oauth: { credentialKey: 'mcp-client/demo' } } }, [1])
    const ctx = contextOf({
      settings,
      webServer: {},
      mcpManager: {
        list: () => [{ name: 'demo', configured: true, status, authorization: attempt }],
        startAuthorization: async () => attempt,
        cancelAuthorization,
      },
    })
    const running = mcpCommand(ctx, 'auth demo')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)
    await running
    expect(cancelAuthorization).toHaveBeenCalledWith('demo', 'a')
    expect(ctx.notices.map(notice => notice.text).join('\n')).toContain('timed out after 5 minutes')
  })
})

describe('/mcp revision refresh', () => {
  it('removes a server at the revision read after the confirmation', async () => {
    const { settings, writes } = settingsOf({ demo: { transport: 'stdio', command: 'npx' } }, [1, 4])
    const ctx = contextOf({ settings })
    vi.mocked(showChoice).mockResolvedValueOnce('yes')
    await mcpCommand(ctx, 'remove demo')
    expect(writes).toEqual([{ ops: [{ op: 'unset', path: ['servers', 'demo'] }], revision: 4 }])
  })

  it('adds a server at the revision read after the wizard', async () => {
    const { settings, writes } = settingsOf({}, [1, 6])
    const ctx = contextOf({ settings })
    vi.mocked(showTextInput)
      .mockResolvedValueOnce('demo')
      .mockResolvedValueOnce('npx')
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('{}')
    vi.mocked(showChoice).mockResolvedValueOnce('stdio')
    await mcpCommand(ctx, 'add')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.revision).toBe(6)
    expect(writes[0]?.ops).toEqual([{
      op: 'set',
      path: ['servers', 'demo'],
      value: { transport: 'stdio', command: 'npx', args: [] },
    }])
  })
})
