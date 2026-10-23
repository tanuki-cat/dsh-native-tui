import { describe, expect, it, onTestFinished } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { modelCommand } from '../src/ui/commands/model.js'
import { createPalette } from '../src/ui/theme.js'

interface Overlay { render(width: number): string[]; handleInput(data: string): void }
interface Notice { readonly tone: string; readonly text: string }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(llm: unknown) {
  const overlays: Overlay[] = []
  const shown: Overlay[] = []
  const notices: Notice[] = []
  const picker = deferred<Overlay>()
  const controller = new AbortController()
  let renders = 0, hidden = 0
  const tui = {
    requestRender: () => { renders += 1 },
    showOverlay: (component: Overlay) => {
      overlays.push(component)
      shown.push(component)
      if (component.render(100).join('\n').includes('Select model')) picker.resolve(component)
      return { hide: () => { hidden += 1; overlays.splice(overlays.indexOf(component), 1) } }
    },
  }
  const ctx = {
    host: { get: (name: string) => name === 'llm' ? llm : undefined },
    config: { cwd: '/tmp', title: 't', theme: 'plain', fullscreen: false },
    palette: createPalette('plain'), tui,
    active: { id: 'session-1', agent: { options: {}, session: { snapshotEvents: () => [] } } },
    signal: controller.signal,
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    renderStatus: () => {}, attachments: { pending: [], clear: () => {} },
    runCommand: async () => {}, openTuiSettings: async () => {}, showHostSettings: () => {},
    modelSelection: { current: undefined, assembled: undefined },
    setContextWindow: () => {}, persistSelection: async () => {},
  } as unknown as CommandContext
  const runs: Promise<void>[] = []
  onTestFinished(async () => { controller.abort(); await Promise.all(runs) })
  return {
    ctx, overlays, shown, notices, controller, picker: picker.promise,
    renders: () => renders, hidden: () => hidden,
    run: (args = '') => { const run = modelCommand(ctx, args); runs.push(run); return run },
  }
}
const textOf = (overlay: Overlay): string => overlay.render(100).join('\n')
const models = (id: string) => [{ id, name: id }]

describe('/model picker', () => {
  it('shows loading immediately and lists every route concurrently in provider order', async () => {
    const routes = ['local-a', 'remote-b', 'local-c']
    const gates = routes.map(() => deferred<ReturnType<typeof models>>())
    const started: string[] = []
    const h = harness({
      listProviders: () => routes.map(id => ({ id })),
      listModels: (provider: string) => { started.push(provider); return gates[routes.indexOf(provider)]!.promise },
    })
    const run = h.run()
    expect(started).toEqual(routes)
    expect(textOf(h.overlays[0]!)).toContain('Loading model catalogs · 0/3')
    gates[2]!.resolve(models('c'))
    gates[0]!.resolve(models('a'))
    gates[1]!.resolve(models('b'))
    const picker = await h.picker
    const text = textOf(picker)
    expect(text).toContain('Select model · 3 available')
    const positions = ['local-a/a', 'remote-b/b', 'local-c/c'].map(row => text.indexOf(row))
    expect(positions.every(position => position !== -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(h.hidden()).toBe(1)
    picker.handleInput('\x1b')
    await run
    expect(h.overlays).toHaveLength(0)
  })

  it('reports failed catalogues while keeping healthy routes and redacting raw errors', async () => {
    const h = harness({
      listProviders: () => [{ id: 'broken' }, { id: 'healthy' }],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('https://secret.example?key=DO-NOT-SHOW')
        return models('ok')
      },
    })
    const run = h.run()
    const picker = await h.picker
    expect(textOf(picker)).toContain('healthy/ok')
    expect(textOf(picker)).not.toContain('broken/')
    expect(h.notices).toEqual([{ tone: 'warning', text: 'Model catalogs unavailable: broken (catalog request failed)' }])
    expect(JSON.stringify(h.notices)).not.toContain('DO-NOT-SHOW')
    picker.handleInput('\x1b')
    await run
  })

  it('distinguishes a genuine empty catalogue from a loading failure', async () => {
    const h = harness({ listProviders: () => [{ id: 'empty' }], listModels: async () => [] })
    await h.run()
    expect(h.notices).toEqual([{ tone: 'warning', text: 'The LLM catalog advertises no models.' }])
    expect(h.overlays).toHaveLength(0)
  })

  it('reports missing credentials separately when every catalogue fails', async () => {
    const h = harness({
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => { throw Object.assign(new Error('private detail'), { code: 'MISSING_CREDENTIAL' }) },
    })
    await h.run()
    expect(h.notices.map(row => row.text)).toEqual([
      'Model catalogs unavailable: deepseek-official (missing credentials)',
      'No models loaded. Some catalogs failed; check credentials or connectivity.',
    ])
    expect(h.overlays).toHaveLength(0)
  })

  it('selects the picked model and reports its reasoning efforts', async () => {
    const resolved: string[] = []
    const h = harness({
      listProviders: () => [{ id: 'gateway' }], listModels: async () => models('alpha'),
      resolveModelInfo: async (provider: string, model: string) => {
        resolved.push(provider + '/' + model)
        return { context: { contextWindow: 128000 }, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
      },
    })
    const run = h.run()
    const picker = await h.picker
    picker.handleInput('\r')
    await run
    expect(resolved).toEqual(['gateway/alpha'])
    expect(h.ctx.modelSelection.current).toEqual({ provider: 'gateway', model: 'alpha' })
    expect(h.notices.map(row => row.text)).toContain('Model selected: gateway/alpha (applies to the next step)')
  })

  it.each(['escape', 'parent'])('cancels loading via %s and ignores a late completion', async (mode) => {
    const gate = deferred<ReturnType<typeof models>>()
    const h = harness({ listProviders: () => [{ id: 'slow' }], listModels: () => gate.promise })
    const run = h.run()
    if (mode === 'escape') h.overlays[0]!.handleInput('\x1b')
    else h.controller.abort()
    await run
    expect(h.overlays).toHaveLength(0)
    const renders = h.renders()
    gate.resolve(models('late'))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(h.shown).toHaveLength(1)
    expect(h.renders()).toBe(renders)
    expect(h.notices).toEqual([])
  })

  it('contains a late rejection after cancellation', async () => {
    const gate = deferred<ReturnType<typeof models>>()
    const h = harness({ listProviders: () => [{ id: 'slow' }], listModels: () => gate.promise })
    const run = h.run()
    h.controller.abort()
    await run
    gate.reject(new Error('late failure'))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(h.notices).toEqual([])
    expect(h.shown).toHaveLength(1)
  })

  it('does not query Host catalogues when already canceled', async () => {
    const h = harness({ listProviders: () => { throw new Error('must not query') } })
    h.controller.abort()
    await h.run()
    expect(h.shown).toHaveLength(0)
    expect(h.notices).toEqual([])
  })

  it('uses the current Host directory on each invocation without discovering or saving models', async () => {
    let catalog = models('added')
    const h = harness({
      listProviders: () => [{ id: 'deepseek-official' }], listModels: async () => catalog,
      discoverModels: () => { throw new Error('must not rewrite Host catalogues') },
    })
    const first = h.run()
    const firstPicker = await h.picker
    expect(textOf(firstPicker)).toContain('deepseek-official/added')
    firstPicker.handleInput('\x1b')
    await first
    catalog = models('fallback')
    const second = h.run()
    // One event-loop turn drains the already-resolved Host reads and opens the picker.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const next = h.overlays[0]!
    expect(textOf(next)).toContain('deepseek-official/fallback')
    expect(textOf(next)).not.toContain('added')
    next.handleInput('\x1b')
    await second
  })

  it('does not open a loading surface for direct model selection', async () => {
    const h = harness({ resolveModelInfo: async () => ({}) })
    await h.run('custom/my-model')
    expect(h.shown).toHaveLength(0)
    expect(h.ctx.modelSelection.current).toEqual({ provider: 'custom', model: 'my-model' })
  })

  it('reports provider enumeration failure without exposing its raw error', async () => {
    const h = harness({ listProviders: () => { throw new Error('private detail') } })
    await h.run()
    expect(h.notices).toEqual([{ tone: 'error', text: 'Could not load model catalogs. Check provider configuration and retry /model.' }])
    expect(h.shown).toHaveLength(0)
  })
})
