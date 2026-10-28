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

function harness(llm: unknown, locale?: unknown) {
  const listeners = new Map<string, Set<(provider?: string) => void>>()
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
    host: {
      get: (name: string) => name === 'llm' ? llm : name === 'locale' ? locale : undefined,
      on: (name: string, callback: (provider?: string) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(callback)
        return () => { listeners.get(name)!.delete(callback) }
      },
    },
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
    emit: (event = 'llm/models-updated', provider = 'p') => { for (const listener of listeners.get(event) ?? []) listener(provider) },
    listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    renders: () => renders, hidden: () => hidden,
    run: (args = '') => { const run = modelCommand(ctx, args); runs.push(run); return run },
  }
}
const textOf = (overlay: Overlay): string => overlay.render(100).join('\n')
const models = (id: string) => [{ id, name: id }]

const flushUpdates = () => new Promise<void>(resolve => { setImmediate(resolve) })

describe('/model live catalogs', () => {
  it('reloads only the provider named by a catalog event', async () => {
    const calls: string[] = []
    const h = harness({ listProviders: () => [{ id: 'p' }, { id: 'q' }], listModels: async (id: string) => { calls.push(id); return models(calls.length <= 2 ? 'old' : 'new') } })
    const run = h.run(), picker = await h.picker
    calls.splice(0)
    h.emit('llm/models-updated', 'p'); await flushUpdates()
    expect(calls).toEqual(['p'])
    picker.handleInput(String.fromCharCode(27)); await run
  })

  it('commits healthy refreshes without waiting for another provider and retains failed rows', async () => {
    const q = deferred<ReturnType<typeof models>>()
    let refreshing = false
    const h = harness({
      listProviders: () => [{ id: 'p' }, { id: 'q' }],
      listModels: (id: string) => refreshing && id === 'q' ? q.promise : Promise.resolve(models(refreshing ? 'new' : 'old')),
    })
    const run = h.run(), picker = await h.picker
    refreshing = true
    h.emit('llm/adapters-updated'); await flushUpdates()
    expect(textOf(picker)).toContain('p/new')
    expect(textOf(picker)).toContain('q/old')
    q.reject(new Error('secret endpoint')); await flushUpdates()
    expect(textOf(picker)).toContain('Refresh failed: q')
    expect(textOf(picker)).toContain('q/old')
    expect(textOf(picker)).not.toContain('secret endpoint')
    picker.handleInput(String.fromCharCode(27)); await run
  })

  it('removes old rows immediately and rejects reads from a deleted then re-added route', async () => {
    const oldRoute = deferred<ReturnType<typeof models>>(), newRoute = deferred<ReturnType<typeof models>>()
    let providers = [{ id: 'p' }], calls = 0
    const h = harness({ listProviders: () => providers, listModels: () => ++calls === 1 ? Promise.resolve(models('initial')) : calls === 2 ? oldRoute.promise : newRoute.promise })
    const run = h.run(), picker = await h.picker
    h.emit(); await flushUpdates()
    providers = []
    h.emit('llm/adapters-updated'); await flushUpdates()
    expect(textOf(picker)).not.toContain('p/initial')
    providers = [{ id: 'p' }]
    h.emit('llm/adapters-updated'); await flushUpdates()
    newRoute.resolve(models('replacement')); await flushUpdates()
    oldRoute.resolve(models('obsolete')); await flushUpdates()
    expect(textOf(picker)).toContain('p/replacement')
    expect(textOf(picker)).not.toContain('obsolete')
    picker.handleInput(String.fromCharCode(27)); await run
  })

  it('renders localized badges without adding catalog metadata to the selection', async () => {
    const h = harness({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'Model', badge: { text: { en: 'New', zh: '新模型' }, tone: 'info' } }],
      resolveModelInfo: async () => ({}),
    }, { resolveText: (text: { zh: string }) => text.zh })
    const run = h.run()
    const picker = await h.picker
    expect(textOf(picker)).toContain('[新模型]')
    picker.handleInput('\r')
    await run
    expect(h.ctx.modelSelection.current).toEqual({ provider: 'p', model: 'm' })
    expect(h.listeners()).toBe(0)
  })

  it('preserves filter and selected identity when a refresh reorders matching models', async () => {
    let catalog = [...models('alpha'), ...models('beta')]
    const h = harness({ listProviders: () => [{ id: 'p' }], listModels: async () => catalog, resolveModelInfo: async () => ({}) })
    const run = h.run()
    const picker = await h.picker
    picker.handleInput('be')
    catalog = [...models('betty'), ...models('beta'), ...models('alpha')]
    h.emit()
    await flushUpdates()
    expect(textOf(picker)).toContain('betty')
    expect(textOf(picker)).not.toContain('alpha')
    picker.handleInput('\r')
    await run
    expect(h.ctx.modelSelection.current?.model).toBe('beta')
    expect(h.listeners()).toBe(0)
  })

  it('retains loaded models on failure and clears a removed badge on recovery', async () => {
    let fail = false, badge = true
    const h = harness({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => {
        if (fail) throw new Error('secret-address')
        return [{ id: 'm', name: 'Model', ...(badge ? { badge: { text: 'New', tone: 'success' } } : {}) }]
      },
    })
    const run = h.run(), picker = await h.picker
    fail = true
    h.emit()
    await flushUpdates()
    expect(textOf(picker)).toContain('p/m')
    expect(textOf(picker)).toContain('Refresh failed')
    expect(textOf(picker)).not.toContain('secret-address')
    fail = false; badge = false
    h.emit()
    await flushUpdates()
    expect(textOf(picker)).not.toContain('[New]')
    expect(textOf(picker)).not.toContain('Refresh failed')
    picker.handleInput('\x1b')
    await run
  })

  it('ignores superseded reads and late results after closing', async () => {
    const older = deferred<ReturnType<typeof models>>(), newer = deferred<ReturnType<typeof models>>(), late = deferred<ReturnType<typeof models>>()
    let calls = 0
    const h = harness({ listProviders: () => [{ id: 'p' }], listModels: () => ++calls === 1 ? Promise.resolve(models('initial')) : calls === 2 ? older.promise : calls === 3 ? newer.promise : late.promise })
    const run = h.run(), picker = await h.picker
    h.emit(); await flushUpdates()
    h.emit(); await flushUpdates()
    newer.resolve(models('newest')); await flushUpdates()
    older.resolve(models('outdated')); await flushUpdates()
    expect(textOf(picker)).toContain('newest')
    expect(textOf(picker)).not.toContain('outdated')
    h.emit(); await flushUpdates()
    picker.handleInput('\x1b'); await run
    const renders = h.renders()
    late.resolve(models('after-close'))
    h.emit(); await flushUpdates()
    expect(h.renders()).toBe(renders)
    expect(h.listeners()).toBe(0)
  })

  it('keeps an empty initial result open when a catalog update arrived during loading', async () => {
    const initial = deferred<ReturnType<typeof models>>()
    let calls = 0
    const h = harness({ listProviders: () => [{ id: 'p' }], listModels: () => ++calls === 1 ? initial.promise : Promise.resolve(models('fresh')) })
    const run = h.run()
    h.emit('llm/models-updated', 'p')
    initial.resolve([])
    await flushUpdates()
    const picker = h.shown.find(overlay => textOf(overlay).includes('Select model'))
    expect(picker).toBeDefined()
    expect(textOf(picker!)).toContain('p/fresh')
    picker!.handleInput(String.fromCharCode(27)); await run
  })

  it('does not lose updates during initial loading and rereads provider topology', async () => {
    const initial = deferred<ReturnType<typeof models>>()
    let calls = 0, providers = [{ id: 'p' }]
    const h = harness({ listProviders: () => providers, listModels: () => ++calls === 1 ? initial.promise : Promise.resolve(models('fresh')) })
    const run = h.run()
    h.emit()
    initial.resolve(models('old'))
    const picker = await h.picker
    await flushUpdates()
    expect(textOf(picker)).toContain('p/fresh')
    providers = [{ id: 'q' }]
    h.emit('llm/adapters-updated'); await flushUpdates()
    expect(textOf(picker)).toContain('q/fresh')
    expect(textOf(picker)).not.toContain('p/fresh')
    picker.handleInput('\x1b'); await run
  })
})

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
