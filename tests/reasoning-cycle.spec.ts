import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CommandContext } from '../src/ui/commands/context.js'
import type { LLM } from '../src/ui/commands/services.js'
import { cycleReasoningEffort, reasoningCommand } from '../src/ui/commands/model.js'

type ModelInfo = Awaited<ReturnType<LLM['resolveModelInfo']>>
const offered = (...ids: string[]): ModelInfo => ({ reasoning: { efforts: ids.map(id => ({ id, name: id })) } })

function harness(info: ModelInfo = offered('low', 'medium', 'high'), effort?: string) {
  const resolve = vi.fn(async () => info)
  const persist = vi.fn(async () => {})
  const render = vi.fn()
  const notice = vi.fn()
  const controller = new AbortController()
  const ctx = {
    host: { get: () => ({ resolveModelInfo: resolve }) },
    active: { agent: { status: 'idle' } },
    modelSelection: { current: {
      provider: 'mock', model: 'model',
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    } },
    signal: controller.signal,
    persistSelection: persist,
    renderStatus: render,
    notice,
  } as unknown as CommandContext
  return { ctx, resolve, persist, render, notice, controller }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('reasoning effort cycle', () => {
  it('cycles the advertised map and wraps without inserting provider default', async () => {
    const h = harness(offered('low', 'medium', 'high'), 'low')
    for (const expected of ['medium', 'high', 'low']) {
      await cycleReasoningEffort(h.ctx)
      expect(h.ctx.modelSelection.current?.reasoningEffort).toBe(expected)
    }
    expect(h.resolve).toHaveBeenCalledWith('mock', 'model')
    expect(h.persist).toHaveBeenCalledTimes(3)
    expect(h.render).toHaveBeenCalledTimes(3)
  })

  it('advances from the provider default when no explicit effort is selected', async () => {
    const h = harness({ reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })), defaultEffort: 'medium' } })
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('high')
  })

  it.each([undefined, 'removed-level'])('starts at the first offered level when the current value is %s', async current => {
    const h = harness(offered('low', 'high'), current)
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('low')
  })

  it('skips absent levels and only offers off when the model advertises it', async () => {
    const h = harness(offered('off', 'high'), 'off')
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('high')
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('off')
  })

  it('does not save or redraw when the only offered level is already selected', async () => {
    const h = harness(offered('high'), 'high')
    await cycleReasoningEffort(h.ctx)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.render).not.toHaveBeenCalled()
  })

  it.each([{}, offered()])('keeps an unsupported model unchanged and explains how to add a map', async info => {
    const h = harness(info)
    const selected = h.ctx.modelSelection.current
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current).toBe(selected)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.notice.mock.calls[0]?.[1]).toContain('/reasoning map')
  })

  it('reports missing selection and missing catalog without opening dialogs', async () => {
    const h = harness()
    h.ctx.modelSelection.current = undefined
    await cycleReasoningEffort(h.ctx)
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('warning', 'No active model selection is available.')
    const missing = harness()
    vi.spyOn(missing.ctx.host, 'get').mockReturnValue(undefined)
    await cycleReasoningEffort(missing.ctx)
    expect(missing.notice).toHaveBeenCalledWith('warning', 'The LLM catalog service is unavailable.')
  })

  it('contains lookup failure without changing the selected effort', async () => {
    const h = harness(offered('low', 'high'), 'low')
    h.resolve.mockRejectedValueOnce(new Error('catalog offline'))
    await cycleReasoningEffort(h.ctx)
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('low')
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('error', 'Could not inspect reasoning efforts: catalog offline')
  })

  it('does not start a lookup after cancellation', async () => {
    const h = harness()
    h.controller.abort()
    await cycleReasoningEffort(h.ctx)
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'session', 'model', 'effort'])('ignores a late lookup after a %s change', async change => {
    const h = harness(offered('low', 'high'), 'low')
    const gate = deferred<ModelInfo>()
    h.resolve.mockImplementationOnce(() => gate.promise)
    let currentSession = true
    const running = cycleReasoningEffort(h.ctx, () => currentSession)
    expect(h.resolve).toHaveBeenCalledTimes(1)
    if (change === 'cancel') h.controller.abort()
    if (change === 'session') currentSession = false
    if (change === 'model') h.ctx.modelSelection.current = { provider: 'other', model: 'model' }
    if (change === 'effort') h.ctx.modelSelection.current = { provider: 'mock', model: 'model', reasoningEffort: ReasoningEffortId('high') }
    const selected = h.ctx.modelSelection.current
    gate.resolve(offered('low', 'high'))
    await running
    expect(h.ctx.modelSelection.current).toBe(selected)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.notice).not.toHaveBeenCalled()
  })

  it('uses the same selection and persistence path as /reasoning', async () => {
    const h = harness(offered('low', 'high'), 'low')
    await reasoningCommand(h.ctx, 'high')
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBe('high')
    expect(h.persist).toHaveBeenCalledOnce()
    expect(h.render).toHaveBeenCalledOnce()
    await reasoningCommand(h.ctx, 'default')
    expect(h.ctx.modelSelection.current?.reasoningEffort).toBeUndefined()
  })
})
