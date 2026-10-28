import { describe, expect, it, vi } from 'vitest'
import { bindModelSelection, sameModelSelection } from '../src/runtime/model-selection.js'
import { selectModel, cycleReasoningEffort } from '../src/ui/commands/model.js'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

function harness(selection: ModelSelection = { provider: 'p', model: 'm' }) {
  let current = selection
  const select = vi.fn((next: ModelSelection) => { current = { ...next } })
  const state = bindModelSelection({ model: { current: () => ({ ...current }), select } } as never)
  const ctx = {
    host: { get: () => ({ resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }) }) },
    active: { agent: { options: {} } }, modelSelection: state, signal: new AbortController().signal,
    setContextWindow: vi.fn(), notice: vi.fn(), persistSelection: vi.fn(), renderStatus: vi.fn(),
  }
  return { state, ctx, select }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('model selection ownership and ordering', () => {
  it.each(['abort', 'session'])('does not write, save, or render after %s invalidates a lookup', async reason => {
    const h = harness(), gate = deferred<object>(), controller = new AbortController()
    let current = true
    const ctx = { ...h.ctx, signal: controller.signal, isCurrent: () => current }
    const running = selectModel(ctx as never, { resolveModelInfo: () => gate.promise } as never, 'p/new')
    if (reason === 'abort') controller.abort()
    else current = false
    gate.resolve({})
    await running
    expect(h.select).not.toHaveBeenCalled()
    expect(h.ctx.setContextWindow).not.toHaveBeenCalled()
    expect(h.ctx.persistSelection).not.toHaveBeenCalled()
    expect(h.ctx.notice).not.toHaveBeenCalled()
    expect(h.ctx.renderStatus).not.toHaveBeenCalled()
  })

  it('keeps the newest request when lookup results arrive out of order across command contexts', async () => {
    const h = harness(), older = deferred<object>(), newer = deferred<object>()
    const oldRun = selectModel(h.ctx as never, { resolveModelInfo: () => older.promise } as never, 'p/older')
    const newRun = selectModel({ ...h.ctx } as never, { resolveModelInfo: () => newer.promise } as never, 'p/newer')
    newer.resolve({}); await newRun
    older.resolve({}); await oldRun
    expect(h.state.current?.model).toBe('newer')
    expect(h.select).toHaveBeenCalledOnce()
    expect(h.ctx.persistSelection).toHaveBeenCalledExactlyOnceWith({ provider: 'p', model: 'newer' })
  })

  it('does not revive an older request when the newest lookup fails', async () => {
    const h = harness(), older = deferred<object>(), newer = deferred<object>()
    const oldRun = selectModel(h.ctx as never, { resolveModelInfo: () => older.promise } as never, 'p/older')
    const newRun = selectModel(h.ctx as never, { resolveModelInfo: () => newer.promise } as never, 'p/newer')
    newer.reject(new Error('unavailable')); await newRun
    older.resolve({}); await oldRun
    expect(h.select).not.toHaveBeenCalled()
    expect(h.ctx.persistSelection).not.toHaveBeenCalled()
    expect(h.ctx.notice).toHaveBeenCalledOnce()
  })

  it('persists the committed snapshot and suppresses late repaint after a Session switch', async () => {
    const h = harness(), saved = deferred<void>()
    let current = true
    const persist = vi.fn(() => saved.promise)
    const run = selectModel({ ...h.ctx, isCurrent: () => current, persistSelection: persist } as never, { resolveModelInfo: async () => ({}) } as never, 'p/new')
    for (let i = 0; i < 4; i++) await Promise.resolve()
    current = false
    h.state.current = { provider: 'other', model: 'session' }
    saved.resolve(); await run
    expect(persist).toHaveBeenCalledExactlyOnceWith({ provider: 'p', model: 'new' })
    expect(h.ctx.renderStatus).not.toHaveBeenCalled()
  })
})

describe('Agent-owned model selection', () => {
  it('writes complete choices through the Agent and reads detached current values', () => {
    const h = harness()
    h.state.current = { provider: 'next', model: 'small', reasoningEffort: 'low' }
    expect(h.select).toHaveBeenCalledExactlyOnceWith({ provider: 'next', model: 'small', reasoningEffort: 'low' })
    expect(h.state.current).toEqual(h.state.current)
    expect(h.state.current).not.toBe(h.state.current)
    expect(sameModelSelection(h.state.current, h.state.current)).toBe(true)
    expect(sameModelSelection(h.state.current, { provider: 'next', model: 'small' })).toBe(false)
  })

  it('keeps provider defaults automatic when selecting a model', async () => {
    const h = harness()
    await selectModel(h.ctx as never, h.ctx.host.get() as never, 'p/next')
    expect(h.select).toHaveBeenCalledExactlyOnceWith({ provider: 'p', model: 'next' })
    expect(h.ctx.persistSelection).toHaveBeenCalledOnce()
  })

  it('cycles effort using detached snapshots and records only the explicit next effort', async () => {
    const h = harness()
    await cycleReasoningEffort(h.ctx as never)
    expect(h.select).toHaveBeenCalledExactlyOnceWith({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('rejects an incomplete replacement without changing the Agent', () => {
    const h = harness()
    expect(() => { h.state.current = undefined }).toThrow('complete model selection')
    expect(h.select).not.toHaveBeenCalled()
  })
})
