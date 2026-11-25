import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { providerCommand } from '../src/ui/commands/provider.js'
import type { SettingsService } from '../src/ui/commands/services.js'
import { showChoice, showSearchChoice, showTextInput } from '../src/ui/dialogs.js'

vi.mock('../src/ui/dialogs.js', () => ({
  showChoice: vi.fn(),
  showSearchChoice: vi.fn(),
  showTextInput: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.DEMO_CATALOG_KEY
})

/** One recorded notice. */
interface Notice {
  readonly tone: string
  readonly text: string
}

/** A command context exposing only the services a case supplies. */
function contextOf(services: Record<string, unknown>): CommandContext & { notices: Notice[] } {
  const notices: Notice[] = []
  const host = {
    get: (name: string) => services[name],
    on: () => () => undefined,
    commands: { list: () => [] },
  }
  const ctx = {
    notices,
    host,
    config: { cwd: '/tmp', title: 't', theme: 'auto', fullscreen: false },
    palette: { dim: (value: string) => value, bold: (value: string) => value },
    tui: {},
    active: { id: 'session-1', agent: { session: { header: {} }, status: 'idle' } },
    signal: new AbortController().signal,
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
function settingsOf(providers: Record<string, unknown>, revisions: readonly number[]) {
  const calls: { readonly ops: readonly unknown[]; readonly revision: number | undefined }[] = []
  let reads = 0
  const service = {
    describe: () => {
      const revision = revisions[Math.min(reads, revisions.length - 1)]!
      reads += 1
      return [{
        ns: 'llm-pi-ai',
        value: { providers },
        schema: {},
        revision,
        applies: 'live' as const,
        autoGenerate: true,
        secrets: [],
      }]
    },
    update: async () => undefined,
    mutate: async (_ns: string, ops: readonly unknown[], revision?: number) => { calls.push({ ops, revision }) },
  }
  return { service: service as unknown as SettingsService, calls }
}

describe('/provider add credential handling', () => {
  it('does not store an API key when the wizard is cancelled later', async () => {
    const credentials = { set: vi.fn(async () => undefined), resolve: async () => undefined }
    const mutate = vi.fn(async () => undefined)
    const ctx = contextOf({
      settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 }], mutate },
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => [],
        discoverModels: async () => [{ id: 'm1' }],
      },
      credentials,
    })
    vi.mocked(showChoice)
      .mockResolvedValueOnce('openai-completions')
      .mockResolvedValueOnce('store')
      .mockResolvedValueOnce(undefined)
    vi.mocked(showTextInput)
      .mockResolvedValueOnce('gw')
      .mockResolvedValueOnce('https://api.example.com/v1')
      .mockResolvedValueOnce('sk-test')

    await providerCommand(ctx, 'add')

    expect(credentials.set).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('stores the key only after the route write and uses the fresh revision', async () => {
    const order: string[] = []
    const credentials = {
      set: vi.fn(async () => { order.push('credential') }),
      resolve: async () => undefined,
    }
    const { service, calls } = settingsOf({}, [5, 9])
    const settings = {
      ...service,
      mutate: async (_ns: string, ops: readonly unknown[], revision?: number) => {
        order.push('settings')
        calls.push({ ops, revision })
      },
    } as unknown as SettingsService
    const ctx = contextOf({
      settings,
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => [],
        discoverModels: async () => [{ id: 'm1' }],
        resolveModelInfo: async () => ({}),
      },
      credentials,
    })
    vi.mocked(showChoice)
      .mockResolvedValueOnce('openai-completions')
      .mockResolvedValueOnce('store')
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('text')
    vi.mocked(showTextInput)
      .mockResolvedValueOnce('gw')
      .mockResolvedValueOnce('https://api.example.com/v1')
      .mockResolvedValueOnce('sk-test')
      .mockResolvedValueOnce('low,medium,high')

    await providerCommand(ctx, 'add')

    expect(order).toEqual(['settings', 'credential'])
    expect(credentials.set).toHaveBeenCalledWith('GW_API_KEY', 'sk-test')
    expect(calls[0]?.revision).toBe(9)
    expect(calls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'gw'],
      value: expect.objectContaining({ apiKeyEnv: 'GW_API_KEY' }),
    }])
  })
})

describe('/provider catalog credential replacement', () => {
  it('updates only apiKeyEnv and keeps models and overrides', async () => {
    process.env.DEMO_CATALOG_KEY = 'exported'
    const { service, calls } = settingsOf({
      demo: { models: [{ id: 'm1', contextWindow: 1000 }], modelOverrides: { m1: { contextWindow: 2000 } } },
    }, [3])
    const ctx = contextOf({
      settings: service,
      llm: {
        listProviders: () => [{ id: 'demo' }],
        listConfigurableProviders: () => [{ provider: 'demo', settingsNs: 'llm-pi-ai' }],
        listModels: async () => [],
        discoverModels: async () => [],
      },
    })
    vi.mocked(showChoice)
      .mockResolvedValueOnce('catalog')
      .mockResolvedValueOnce('env')
      .mockResolvedValueOnce('yes')
    vi.mocked(showSearchChoice).mockResolvedValueOnce('demo')
    vi.mocked(showTextInput).mockResolvedValueOnce('DEMO_CATALOG_KEY')

    await providerCommand(ctx, 'add')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ops).toEqual([{ op: 'set', path: ['providers', 'demo', 'apiKeyEnv'], value: 'DEMO_CATALOG_KEY' }])
    expect(JSON.stringify(calls[0]?.ops)).not.toContain('models')
    expect(JSON.stringify(calls[0]?.ops)).not.toContain('modelOverrides')
  })

  it('rolls back a newly added route when storing its API key fails', async () => {
    const { service, calls } = settingsOf({}, [1, 2, 3])
    const ctx = contextOf({
      settings: service,
      credentials: {
        set: vi.fn(async () => { throw new Error('keychain locked') }),
        resolve: async () => undefined,
      },
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [{ provider: 'demo', settingsNs: 'llm-pi-ai', displayName: 'Demo' }],
        listModels: async () => [],
        discoverModels: async () => [],
      },
    })
    vi.mocked(showChoice)
      .mockResolvedValueOnce('catalog')
      .mockResolvedValueOnce('store')
    vi.mocked(showSearchChoice).mockResolvedValueOnce('demo')
    vi.mocked(showTextInput).mockResolvedValueOnce('sk-secret-value')

    await providerCommand(ctx, 'add')

    expect(calls).toHaveLength(2)
    expect(calls[1]?.ops).toEqual([{ op: 'unset', path: ['providers', 'demo'] }])
    expect(ctx.notices.some(notice => notice.tone === 'error' && notice.text.includes('rolled back'))).toBe(true)
  })
})

describe('/provider model discovery writes', () => {
  it('writes only the model list so redacted secret fields are preserved', async () => {
    const { service, calls } = settingsOf({
      demo: { baseURL: 'https://api.example.com/v1', api: 'openai-completions', apiKey: '***redacted***' },
    }, [2])
    const ctx = contextOf({
      settings: service,
      llm: {
        listProviders: () => [{ id: 'demo' }],
        listConfigurableProviders: () => [],
        listModels: async () => [],
        discoverModels: async () => [{ id: 'm1', name: 'Model 1' }],
      },
    })

    await providerCommand(ctx, 'models demo')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ops[0]).toMatchObject({ op: 'set', path: ['providers', 'demo', 'models'] })
    expect(JSON.stringify(calls[0]?.ops)).not.toContain('redacted')
  })
})

describe('/provider list', () => {
  it('reports an unavailable catalogue instead of zero models', async () => {
    const ctx = contextOf({
      settings: {
        describe: () => [{
          ns: 'llm-pi-ai',
          value: { providers: { gw: { apiKeyEnv: 'GW_API_KEY' } } },
          revision: 1,
        }],
      },
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => { throw new Error('connection refused') },
        discoverModels: async () => [],
      },
    })
    await providerCommand(ctx, 'list')
    const text = ctx.notices.map(notice => notice.text).join('\n')
    expect(text).toContain('models unavailable')
    expect(text).not.toContain('0 model(s)')
  })
})
