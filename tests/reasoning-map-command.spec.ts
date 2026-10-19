import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { reasoningCommand } from '../src/ui/commands/model.js'
import { createPalette } from '../src/ui/theme.js'

interface Notice {
  readonly tone: string
  readonly text: string
}

interface Overlay {
  render(width: number): string[]
  handleInput(data: string): void
}

function overlayHarness(): { tui: never; overlays: Overlay[] } {
  const overlays: Overlay[] = []
  const tui = {
    showOverlay(component: Overlay) {
      overlays.push(component)
      return { hide() {} }
    },
  }
  return { tui: tui as never, overlays }
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

function contextOf(options: {
  readonly tui: never
  readonly settings?: unknown
  readonly llm?: unknown
  readonly selection?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}): CommandContext & { notices: Notice[]; persisted: () => number } {
  const notices: Notice[] = []
  let persisted = 0
  const host = {
    get: (name: string) => name === 'settings'
      ? options.settings
      : name === 'llm' ? options.llm : undefined,
  }
  return {
    notices,
    persisted: () => persisted,
    host: host as unknown as CommandContext['host'],
    config: { cwd: '/tmp', title: 't', theme: 'auto', fullscreen: false } as unknown as CommandContext['config'],
    palette: createPalette('plain'),
    tui: options.tui,
    active: { id: 'session-1', agent: { session: { snapshotEvents: () => [] } } } as unknown as CommandContext['active'],
    signal: new AbortController().signal,
    notice: (tone, text) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: {
      current: options.selection === undefined ? undefined : { ...options.selection },
      assembled: undefined,
    },
    setContextWindow: () => undefined,
    persistSelection: async () => { persisted += 1 },
  }
}

function allText(ctx: { notices: Notice[] }): string {
  return ctx.notices.map(notice => notice.text).join('\n')
}

function press(overlay: Overlay | undefined, keys: readonly string[]): void {
  if (overlay === undefined) throw new Error('expected an overlay')
  for (const key of keys) overlay.handleInput(key)
}

/** Settings stub whose one namespace carries the supplied provider value. */
function settingsWith(
  providers: unknown,
  options: {
    readonly user?: unknown
    readonly revision?: number
    readonly onMutate?: (ns: string, ops: readonly unknown[], revision?: number) => void
  } = {},
): unknown {
  return {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers },
      ...(options.user === undefined ? {} : { user: options.user }),
      schema: {},
      revision: options.revision ?? 1,
    }],
    update: async () => undefined,
    mutate: async (ns: string, ops: readonly unknown[], revision?: number) => {
      options.onMutate?.(ns, ops, revision)
    },
  }
}

describe('guided reasoning map', () => {
  it('refuses when the settings service is unavailable', async () => {
    const ctx = contextOf({ tui: overlayHarness().tui, selection: { provider: 'gateway', model: 'alpha' } })
    await reasoningCommand(ctx, 'map')
    expect(allText(ctx)).toContain('The settings service is unavailable in this profile.')
  })

  it('refuses without the llm-pi-ai namespace or a configured route', async () => {
    const missingNamespace = contextOf({
      tui: overlayHarness().tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings: { describe: () => [], update: async () => undefined, mutate: async () => undefined },
    })
    await reasoningCommand(missingNamespace, 'map')
    expect(allText(missingNamespace)).toContain('The llm-pi-ai settings namespace is unavailable')

    const missingRoute = contextOf({
      tui: overlayHarness().tui,
      selection: { provider: 'codebuddy', model: 'alpha' },
      settings: settingsWith({}),
    })
    await reasoningCommand(missingRoute, 'map')
    expect(allText(missingRoute)).toContain('is not served by a configured llm-pi-ai route')
  })

  it('adds a level with a custom wire spelling and saves one leaf edit', async () => {
    const calls: Array<{ ns: string; ops: readonly unknown[]; revision?: number }> = []
    const harness = overlayHarness()
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low', high: 'high' } }]
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings: settingsWith(
        { gateway: { models } },
        {
          user: { providers: { gateway: { models } } },
          revision: 9,
          onMutate: (ns, ops, revision) => { calls.push({ ns, ops, revision }) },
        },
      ),
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\r'])
    await flush()
    press(harness.overlays[1], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await flush()
    press(harness.overlays[2], ['\x7f', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f', 'xhigh', '\r'])
    await flush()
    press(harness.overlays[3], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run

    expect(calls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models', '0', 'reasoningEfforts'],
        value: { low: 'low', medium: 'xhigh', high: 'high' },
      }],
      revision: 9,
    }])
    expect(allText(ctx)).toContain('Saved reasoning map for gateway/alpha: low → low, medium → xhigh, high → high')
    expect(ctx.modelSelection.current).toEqual({ provider: 'gateway', model: 'alpha' })
  })

  it('removes the current level and clears the stale explicit effort', async () => {
    const calls: Array<{ ops: readonly unknown[] }> = []
    const harness = overlayHarness()
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low', high: 'high' } }]
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha', reasoningEffort: 'high' },
      settings: settingsWith(
        { gateway: { models } },
        {
          user: { providers: { gateway: { models } } },
          onMutate: (_ns, ops) => { calls.push({ ops }) },
        },
      ),
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\x1b[B', '\r'])
    await flush()
    press(harness.overlays[1], ['\x1b[B', '\r'])
    await flush()
    press(harness.overlays[2], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run

    expect(calls).toEqual([{
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models', '0', 'reasoningEfforts'],
        value: { low: 'low' },
      }],
    }])
    expect(ctx.modelSelection.current).toEqual({ provider: 'gateway', model: 'alpha' })
    expect(ctx.persisted()).toBe(1)
    expect(allText(ctx)).toContain('is no longer mapped for gateway/alpha')
  })

  it('writes catalog overrides as a modelOverrides leaf', async () => {
    const calls: Array<{ ops: readonly unknown[] }> = []
    const harness = overlayHarness()
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'anthropic', model: 'claude-x' },
      settings: settingsWith(
        { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
        { onMutate: (_ns, ops) => { calls.push({ ops }) } },
      ),
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\r'])
    await flush()
    press(harness.overlays[1], ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await flush()
    press(harness.overlays[2], ['\r'])
    await flush()
    press(harness.overlays[3], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run

    expect(calls).toEqual([{
      ops: [{
        op: 'set',
        path: ['providers', 'anthropic', 'modelOverrides', 'claude-x', 'reasoningEfforts'],
        value: { high: 'high' },
      }],
    }])
  })

  it('stages catalog levels when a catalog route has no stored override', async () => {
    const calls: Array<{ ops: readonly unknown[] }> = []
    const harness = overlayHarness()
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'anthropic', model: 'claude-x' },
      settings: settingsWith(
        { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
        { onMutate: (_ns, ops) => { calls.push({ ops }) } },
      ),
      llm: {
        resolveModelInfo: async () => ({
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
          },
        }),
      },
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    expect(allText(ctx)).toContain('staged the catalog levels with same-name wire values')
    expect(harness.overlays[0]?.render(80).join('\n')).toContain('catalog levels (staged same-name)')
    press(harness.overlays[0], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run

    expect(calls).toEqual([{
      ops: [{
        op: 'set',
        path: ['providers', 'anthropic', 'modelOverrides', 'claude-x', 'reasoningEfforts'],
        value: { low: 'low', high: 'high' },
      }],
    }])
  })

  it('seeds an explicit models entry and confirms an inherited array write', async () => {
    const calls: Array<{ ops: readonly unknown[] }> = []
    const harness = overlayHarness()
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings: settingsWith(
        { gateway: { models: [{ id: 'alpha' }] } },
        { onMutate: (_ns, ops) => { calls.push({ ops }) } },
      ),
      llm: {
        resolveModelInfo: async () => ({
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
          },
        }),
      },
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    expect(allText(ctx)).toContain('staged the catalog levels with same-name wire values')
    expect(harness.overlays[0]?.render(80).join('\n')).toContain('catalog levels (staged same-name)')
    press(harness.overlays[0], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await flush()
    expect(harness.overlays[1]?.render(80).join('\n')).toContain('Write the merged model list?')
    press(harness.overlays[1], ['\r'])
    await run

    expect(calls).toEqual([{
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models'],
        value: [{ id: 'alpha', reasoningEfforts: { low: 'low', high: 'high' } }],
      }],
    }])
  })

  it('keeps the last thinking level mapped', async () => {
    const harness = overlayHarness()
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low' } }]
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings: settingsWith({ gateway: { models } }, { user: { providers: { gateway: { models } } } }),
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\x1b[B', '\r'])
    await flush()
    press(harness.overlays[1], ['\r'])
    await flush()
    expect(allText(ctx)).toContain('Keep at least one thinking level')
    press(harness.overlays[2], ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run
  })

  it('retries after a settings conflict', async () => {
    const harness = overlayHarness()
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low', high: 'high' } }]
    let writes = 0
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: { providers: { gateway: { models } } },
        user: { providers: { gateway: { models } } },
        schema: {},
        revision: 4,
      }],
      update: async () => undefined,
      mutate: async () => {
        writes += 1
        if (writes === 1) throw new Error('settings namespace "llm-pi-ai" changed since it was read')
      },
    }
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings,
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await flush()
    expect(allText(ctx)).toContain('Could not save the reasoning map')
    press(harness.overlays[1], ['\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run
    expect(writes).toBe(2)
    expect(allText(ctx)).toContain('Saved reasoning map for gateway/alpha')
  })

  it('cancels without writing', async () => {
    const calls: unknown[] = []
    const harness = overlayHarness()
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low' } }]
    const ctx = contextOf({
      tui: harness.tui,
      selection: { provider: 'gateway', model: 'alpha' },
      settings: settingsWith({ gateway: { models } }, { onMutate: (...args) => { calls.push(args) } }),
    })
    const run = reasoningCommand(ctx, 'map')
    await flush()
    press(harness.overlays[0], ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r'])
    await run
    expect(calls).toEqual([])
  })
})
