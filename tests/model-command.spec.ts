import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { modelCommand } from '../src/ui/commands/model.js'
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

function contextOf(options: {
  readonly tui: never
  readonly llm: unknown
  readonly selection?: { readonly provider: string; readonly model: string }
}): CommandContext & { notices: Notice[] } {
  const notices: Notice[] = []
  const host = { get: (name: string) => name === 'llm' ? options.llm : undefined }
  return {
    notices,
    host: host as unknown as CommandContext['host'],
    config: { cwd: '/tmp', title: 't', theme: 'auto', fullscreen: false } as unknown as CommandContext['config'],
    palette: createPalette('plain'),
    tui: options.tui,
    active: { id: 'session-1', agent: { options: {}, session: { snapshotEvents: () => [] } } } as unknown as CommandContext['active'],
    signal: new AbortController().signal,
    notice: (tone, text) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: { current: options.selection === undefined ? undefined : { ...options.selection }, assembled: undefined },
    setContextWindow: () => undefined,
    persistSelection: async () => undefined,
  }
}

/** The rendered picker rows, one string per terminal line. */
function pickerText(overlay: Overlay | undefined): string {
  if (overlay === undefined) throw new Error('expected the model picker')
  return overlay.render(100).join('\n')
}

describe('/model picker', () => {
  it('lists every route at once instead of one after another', async () => {
    const { tui, overlays } = overlayHarness()
    // A route's catalogue can be a network round trip, so the picker must open
    // after the slowest route, not after the sum of all of them. Recording how
    // many listings had already settled when each one started separates the
    // two: a sequential loop starts the third route only after two finished.
    const settledAtStart: number[] = []
    let settled = 0
    const llm = {
      listProviders: () => [{ id: 'local-a' }, { id: 'remote-b' }, { id: 'local-c' }],
      listModels: async (provider: string) => {
        settledAtStart.push(settled)
        await new Promise(resolve => { setTimeout(resolve, 5) })
        settled += 1
        return [{ id: provider + '-model', name: provider + '-model' }]
      },
      resolveModelInfo: async () => ({}),
    }
    const ctx = contextOf({ tui, llm })
    const run = modelCommand(ctx, '')
    await new Promise(resolve => { setTimeout(resolve, 60) })
    expect(settledAtStart).toEqual([0, 0, 0])
    const text = pickerText(overlays[0])
    expect(text).toContain('Select model · 3 available')
    // Resolving out of order never reorders the rows: providers keep the order
    // listProviders() reported.
    const rows = ['local-a/local-a-model', 'remote-b/remote-b-model', 'local-c/local-c-model']
    const positions = rows.map(row => text.indexOf(row))
    expect(positions.every(position => position !== -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    overlays[0]!.handleInput('\x1b')
    await run
  })

  it('skips a route whose catalogue fails and keeps the rest', async () => {
    const { tui, overlays } = overlayHarness()
    const llm = {
      listProviders: () => [{ id: 'broken' }, { id: 'healthy' }],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('no credential')
        return [{ id: 'ok', name: 'ok' }]
      },
      resolveModelInfo: async () => ({}),
    }
    const ctx = contextOf({ tui, llm })
    const run = modelCommand(ctx, '')
    await new Promise(resolve => { setTimeout(resolve, 10) })
    const text = pickerText(overlays[0])
    expect(text).toContain('healthy/ok')
    expect(text).not.toContain('broken/')
    overlays[0]!.handleInput('\x1b')
    await run
  })

  it('warns when no route advertises a model', async () => {
    const { tui } = overlayHarness()
    const llm = {
      listProviders: () => [{ id: 'empty' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    }
    const ctx = contextOf({ tui, llm })
    await modelCommand(ctx, '')
    expect(ctx.notices.map(notice => notice.text)).toEqual(['The LLM catalog advertises no models.'])
  })

  it('selects the picked model and reports its reasoning efforts', async () => {
    const { tui, overlays } = overlayHarness()
    const resolved: string[] = []
    const llm = {
      listProviders: () => [{ id: 'gateway' }],
      listModels: async () => [{ id: 'alpha', name: 'Alpha' }],
      resolveModelInfo: async (provider: string, model: string) => {
        resolved.push(provider + '/' + model)
        return { context: { contextWindow: 128000 }, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
      },
    }
    const ctx = contextOf({ tui, llm })
    const run = modelCommand(ctx, '')
    await new Promise(resolve => { setTimeout(resolve, 10) })
    overlays[0]!.handleInput('\r')
    await run
    expect(resolved).toEqual(['gateway/alpha'])
    expect(ctx.modelSelection.current).toEqual({ provider: 'gateway', model: 'alpha' })
    expect(ctx.notices.map(notice => notice.text)).toContain('Model selected: gateway/alpha (applies to the next step)')
  })
})
