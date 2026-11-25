import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentModel, modelSelectionProjectionDefinition, type ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { createHostSession, readContextBreakdown, readContextMeter, restartHostSession, resumeHostSession, sessionAgentPreset, sessionReservedCompletionTokens, unreplayedReasoningTokens } from '../src/runtime/agent.js'
import type { ResolvedConfig } from '../src/config.js'
import type { HostSession } from '../src/runtime/agent.js'

const config: ResolvedConfig = {
  sessionId: undefined,
  cwd: '/tmp/workspace',
  showReasoning: true,
  showImageThumbnails: false,
  thinkingDisplay: 'detailed',
  runCodeDisplay: 'detailed',
  maxTranscriptEntries: 100,
  fullscreen: false,
  theme: 'plain',
  agentPreset: undefined,
  title: 'TUI',
}

function fakeHandle(sessionId: ReturnType<typeof SessionId>, events: readonly unknown[] = []): AgentHandle {
  return {
    agent: {
      id: sessionId,
      status: 'idle',
      options: { provider: 'p', model: 'm' },
      session: { header: { cwd: '/tmp/workspace', createdAt: 0 }, snapshotEvents: () => events },
    },
    dispose: async () => {},
  } as unknown as AgentHandle
}

function fakeContext(overrides: Record<string, unknown>): Context {
  return overrides as unknown as Context
}

describe('same-session Agent restart', () => {
  it('awaits owned resource cleanup before resuming the same persisted Session', async () => {
    const id = SessionId('session-restart')
    let finish!: () => void
    const handle = fakeHandle(id)
    const resume = vi.fn(async () => handle)
    const ctx = fakeContext({ get: () => undefined, agents: { resume } })
    const current = { id, agent: { status: 'idle' }, dispose: vi.fn(() => new Promise<void>(resolve => { finish = resolve })) } as unknown as HostSession
    const restarting = restartHostSession(ctx, current)
    expect(current.dispose).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    finish()
    const reopened = await restarting
    expect(resume).toHaveBeenCalledExactlyOnceWith({ resumeSessionId: id, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' }, setup: expect.any(Function) })
    expect(reopened.id).toBe(id)
    expect(reopened.agent).toBe(handle.agent)
    expect(reopened.agent).not.toBe(current.agent)
  })

  it('does not resume after disposal fails or while the Agent is running', async () => {
    const resume = vi.fn(), dispose = vi.fn(async () => { throw new Error('cleanup failed') })
    const ctx = fakeContext({ get: () => undefined, agents: { resume } })
    const current = { id: SessionId('session-restart'), agent: { status: 'idle' }, dispose } as unknown as HostSession
    await expect(restartHostSession(ctx, current)).rejects.toThrow('cleanup failed')
    expect(resume).not.toHaveBeenCalled()
    Object.assign(current.agent, { status: 'running' })
    await expect(restartHostSession(ctx, current)).rejects.toThrow('running turn')
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('session preset restore', () => {
  it('reads the last selected preset rather than the creation header', () => {
    const session = {
      header: { cwd: '/tmp', createdAt: 0, agentPreset: 'header-preset' },
      snapshotEvents: () => [
        { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } },
      ],
    }
    expect(sessionAgentPreset(session as never)).toBe('ptc')
  })
})

describe('context meter reading', () => {
  const state = { pressureTokens: 300_000, projectedTokens: 420_000, contextWindow: 1_000_000 }
  const projections = { snapshot: () => ({ values: { contextPressure: state } }) }

  it('prefers the request envelope cap over the adapter default', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 100_000 } }) }
    expect(readContextMeter(projections, session as never, 32_768))
      .toEqual({ window: 1_000_000, reading: { tokens: 420_000, reservedTokens: 100_000 } })
  })

  it('falls back to the adapter default when the envelope declared no cap', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    expect(readContextMeter(projections, session as never, 32_768).reading)
      .toEqual({ tokens: 420_000, reservedTokens: 32_768 })
  })

  it('leaves the figure to the log when the projection is unregistered', () => {
    const session = { requestHeader: () => undefined }
    expect(readContextMeter({ snapshot: () => ({ values: {} }) }, session as never, 32_768))
      .toEqual({ window: undefined, reading: undefined })
    expect(readContextMeter(undefined, session as never, undefined))
      .toEqual({ window: undefined, reading: undefined })
  })

  it('keeps the reserved figure while the meter has no sample yet', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 100_000 } }) }
    expect(readContextMeter({ snapshot: () => ({ values: { contextPressure: {} } }) }, session as never, undefined).reading)
      .toEqual({ reservedTokens: 100_000 })
  })
})

describe('context breakdown reading', () => {
  const session = { requestHeader: () => undefined, snapshotEvents: () => [] }

  it('reads the composition from its own projection key', () => {
    // The composition is a separate unit from the pressure projection: the
    // pressure fold prices the surface with the provider's own numbers, while
    // this one prices it with the meter's fixed estimator. Without an anchor the
    // projection's own figures are reported unchanged.
    const projections = {
      snapshot: () => ({ values: { contextBreakdown: { systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 } } }),
    }
    expect(readContextBreakdown(projections, session as never))
      .toEqual({ systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 })
  })

  it('rebases onto the occupancy so no bucket exceeds it', () => {
    const projections = {
      snapshot: () => ({ values: { contextBreakdown: { systemTokens: 50_331, toolsTokens: 628, messageTokens: 373_473 } } }),
    }
    // The real session: messages alone read larger than the whole context.
    const rebased = readContextBreakdown(projections, session as never, 291_662)
    expect(rebased?.messageTokens).toBeLessThan(291_662)
    expect((rebased?.systemTokens ?? 0) + (rebased?.toolsTokens ?? 0) + (rebased?.messageTokens ?? 0))
      .toBe(291_662)
  })

  it('prices the reasoning the provider never receives', () => {
    /** One durable settlement carrying the given content blocks. */
    const settlement = (blocks: readonly unknown[]) => ({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: blocks } },
    })
    const signed = { type: 'reasoning', text: 'a'.repeat(40), thinkingSignature: '{"id":"rs_1"}' }
    const unsigned = { type: 'reasoning', text: 'b'.repeat(40) }
    // 40 chars / 4 = 10 tokens, plus the estimator's 4-token block overhead.
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [settlement([unsigned])] } as never)).toBe(14)
    // A signed block replays, so nothing is dropped.
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [settlement([signed])] } as never)).toBe(0)
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [settlement([signed, unsigned])] } as never)).toBe(14)
  })

  it('counts only reasoning, not other message content', () => {
    // A text-only session drops nothing; the figure must not scale with the
    // surface, only with the unreplayable part of it.
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [] } as never)).toBe(0)
    const textOnly = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } }
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [textOnly] } as never)).toBe(0)
    // The system prompt is not folded into the messages bucket, so it cannot
    // dilute a figure that is subtracted from that bucket.
    const system = { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'x'.repeat(400) }] } } }
    const reasoningOnly = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'b'.repeat(40) }] } } }
    expect(unreplayedReasoningTokens({ snapshotEvents: () => [system, reasoningOnly] } as never)).toBe(14)
  })

  it('reports an unmounted meter instead of an empty composition', () => {
    expect(readContextBreakdown({ snapshot: () => ({ values: {} }) }, session as never)).toBeUndefined()
    expect(readContextBreakdown(undefined, session as never)).toBeUndefined()
  })
})

describe('reserved completion tokens', () => {
  it('prefers the newest request envelope cap', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 65_536 } }) }
    expect(sessionReservedCompletionTokens(session as never)).toBe(65_536)
  })

  it('reports nothing when the envelope declared no cap', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    expect(sessionReservedCompletionTokens(session as never)).toBeUndefined()
  })

  it('reports nothing before the first request header', () => {
    expect(sessionReservedCompletionTokens({ requestHeader: () => undefined } as never)).toBeUndefined()
  })

  it('ignores a cap that cannot bound output', () => {
    for (const maxTokens of [0, -1, Number.NaN]) {
      const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens } }) }
      expect(sessionReservedCompletionTokens(session as never)).toBeUndefined()
    }
  })
})

describe('host runtime', () => {
  it('creates an agent with the configured cwd and default model', async () => {
    let captured: unknown
    const ctx = fakeContext({
      get: (key: string) => key === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
        : undefined,
      agents: {
        create: async (options: unknown) => {
          captured = options
          const sessionId = (options as { sessionId: ReturnType<typeof SessionId> }).sessionId
          return fakeHandle(sessionId)
        },
      },
    })
    const session = await createHostSession(ctx, config)
    expect(captured).toMatchObject({
      meta: { cwd: '/tmp/workspace' },
      agentOptions: { provider: 'default-provider', model: 'default-model' },
    })
    expect(session.id).toContain('native-tui-')
    expect(session.agent.id).toBe(session.id)
    const on = vi.fn(() => () => {})
    await (captured as { setup(ctx: unknown): Promise<void> }).setup({ on })
    expect(on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
  })

  it('mounts the configured agent preset', async () => {
    let mounted: string | undefined
    let captured: unknown
    const ctx = fakeContext({
      get: (key: string) => {
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (key === 'agentPresets') {
          return {
            defaultId: 'standard',
            resolve: async (id?: string) => ({ id: id ?? 'standard' }),
            mount: async (_ctx: unknown, id?: string) => { mounted = id },
            composedPreset: () => undefined,
            list: async () => [],
          }
        }
        return undefined
      },
      agents: {
        create: async (options: unknown) => {
          captured = options
          const candidate = options as {
            sessionId: ReturnType<typeof SessionId>
            setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
          }
          await candidate.setup?.({ on: vi.fn(() => () => {}) }, {})
          return fakeHandle(candidate.sessionId)
        },
      },
    })
    await createHostSession(ctx, { ...config, agentPreset: 'minimal' })
    expect(captured).toMatchObject({ meta: { cwd: '/tmp/workspace', agentPreset: 'minimal' } })
    expect(mounted).toBe('minimal')
  })

  it('resumes with the last selected preset event', async () => {
    let mounted: string | undefined
    const id = SessionId('session-selected')
    const ctx = fakeContext({
      get: (key: string) => key === 'agentPresets'
        ? {
          defaultId: 'standard',
          list: async () => [],
          resolve: async (preset?: string) => ({ id: preset ?? 'standard' }),
          mount: async (_ctx: unknown, preset?: string) => { mounted = preset },
          select: async () => 'standard',
          composedPreset: () => undefined,
        }
        : undefined,
      agents: {
        resume: async (options: unknown) => {
          const candidate = options as {
            resumeSessionId: ReturnType<typeof SessionId>
            setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
          }
          const handle = fakeHandle(candidate.resumeSessionId, [
            { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
          ])
          await candidate.setup?.({ on: vi.fn(() => () => {}) }, handle.agent)
          return handle
        },
      },
    })
    await resumeHostSession(ctx, id)
    expect(mounted).toBe('minimal')
  })

  it.each([false, true])('supplies a blank resume fallback without replacing recorded selection (%s)', async recorded => {
    const saved = { provider: 'history', model: 'saved', reasoningEffort: 'high' }
    const events: Array<{ type: string; data: unknown }> = recorded ? [{ type: 'model/selection', data: saved }] : []
    let state: ModelSelectionProjectionState = { lastUsed: null, pending: null }
    for (const event of events) state = modelSelectionProjectionDefinition.apply(state, event as never)
    let model: AgentModel | undefined
    const ctx = fakeContext({
      get: (name: string) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'configured', model: 'fallback' }) } : undefined,
      agents: { resume: async (options: { agentOptions?: object }) => {
        model = new AgentModel(() => state, { append: vi.fn() } as never, options.agentOptions ?? {})
        return fakeHandle(SessionId('blank-resume'))
      } },
    })
    await resumeHostSession(ctx, SessionId('blank-resume'))
    expect(model?.current()).toEqual(recorded ? saved : { provider: 'configured', model: 'fallback' })
  })

  it('resumes an explicit persisted session', async () => {
    let captured: unknown
    const id = SessionId('session-1')
    const ctx = fakeContext({
      get: () => undefined,
      agents: {
        resume: async (options: unknown) => {
          captured = options
          return fakeHandle(id)
        },
      },
    })
    const session = await resumeHostSession(ctx, id)
    expect(captured).toEqual({ resumeSessionId: id, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' }, setup: expect.any(Function) })
    const on = vi.fn(() => () => {})
    await (captured as { setup(ctx: unknown, agent: unknown): Promise<void> }).setup({ on }, session.agent)
    expect(on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    expect(session.id).toBe(id)
  })
})

describe('owned session disposal', () => {
  it('shares one disposal across concurrent and repeated calls', async () => {
    const id = SessionId('native-tui-disposal')
    let finish!: () => void
    const dispose = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const handle = { ...fakeHandle(id), dispose } as unknown as AgentHandle
    const ctx = fakeContext({ get: () => undefined, agents: { create: async () => handle } })
    const session = await createHostSession(ctx, config)
    const first = session.dispose()
    const second = session.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    finish()
    await Promise.all([first, second])
    await session.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps disposal retryable after a failure while concurrent callers share the rejection', async () => {
    const id = SessionId('native-tui-retry')
    let attempts = 0
    const dispose = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('cleanup failed')
    })
    const handle = { ...fakeHandle(id), dispose } as unknown as AgentHandle
    const ctx = fakeContext({ get: () => undefined, agents: { create: async () => handle } })
    const session = await createHostSession(ctx, config)
    const first = session.dispose()
    const second = session.dispose()
    await expect(first).rejects.toThrow('cleanup failed')
    await expect(second).rejects.toThrow('cleanup failed')
    expect(dispose).toHaveBeenCalledOnce()
    await session.dispose()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('restarts a session whose owned handle was already disposed', async () => {
    const id = SessionId('native-tui-restart-disposed')
    const ctx = fakeContext({
      get: () => undefined,
      agents: {
        create: async () => fakeHandle(id),
        resume: vi.fn(async () => fakeHandle(id)),
      },
    })
    const session = await createHostSession(ctx, config)
    await session.dispose()
    const reopened = await restartHostSession(ctx, session)
    expect(ctx.agents.resume).toHaveBeenCalledOnce()
    expect(reopened.id).toBe(id)
  })
})

describe('createHostSession startup guards', () => {
  it('normalizes blank session, preset, and cwd values before creating the Agent', async () => {
    let captured: { sessionId: ReturnType<typeof SessionId>; meta: { cwd: string } } | undefined
    const resolvePreset = vi.fn(async (preset?: string) => ({ id: preset ?? 'standard' }))
    const ctx = fakeContext({
      get: (key: string) => key === 'agentPresets'
        ? {
          defaultId: 'standard',
          list: async () => [],
          resolve: resolvePreset,
          mount: async () => ({}),
          select: async () => 'standard',
          composedPreset: () => undefined,
        }
        : undefined,
      agents: {
        create: async (options: unknown) => {
          captured = options as typeof captured
          return fakeHandle((options as { sessionId: ReturnType<typeof SessionId> }).sessionId)
        },
      },
    })
    const session = await createHostSession(ctx, { ...config, sessionId: '  ', agentPreset: '\t', cwd: '   ' })
    expect(session.id).toContain('native-tui-')
    expect(captured?.meta.cwd).toBe(process.cwd())
    expect(resolvePreset).toHaveBeenCalledWith(undefined)
  })

  it('resolves a relative working directory before creating the Agent', async () => {
    let captured: { meta: { cwd: string } } | undefined
    const ctx = fakeContext({
      get: () => undefined,
      agents: {
        create: async (options: unknown) => {
          captured = options as typeof captured
          return fakeHandle((options as { sessionId: ReturnType<typeof SessionId> }).sessionId)
        },
      },
    })
    await createHostSession(ctx, { ...config, cwd: 'packages/app' })
    expect(captured?.meta.cwd).toBe(resolve('packages/app'))
  })
})

describe('compaction-shadowed reasoning', () => {
  const reasoning = (seq: number, text: string) => ({
    type: 'assistant/message',
    seq,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text }] } },
  })

  it('skips reasoning carried by an event a compaction replaced', () => {
    const events = [
      reasoning(1, 'a'.repeat(40)),
      reasoning(2, 'b'.repeat(40)),
      { type: 'compaction/summary', seq: 3, data: { shadowedSeqs: [1], shadowedTokenCount: 20 } },
    ]
    // Only the live settlement (39 chars → 14 tokens) still reaches the provider.
    expect(unreplayedReasoningTokens({ snapshotEvents: () => events } as never)).toBe(14)
  })

  it('skips every shadowed event across pruning and keeps unshadowed ones', () => {
    const attempt = { ...reasoning(4, 'c'.repeat(40)), type: 'assistant/attempt' }
    const events = [
      reasoning(1, 'a'.repeat(40)),
      attempt,
      { type: 'compaction/prune', seq: 5, data: { shadowedSeqs: [1, 4], shadowedTokenCount: 40 } },
      reasoning(6, 'd'.repeat(40)),
    ]
    expect(unreplayedReasoningTokens({ snapshotEvents: () => events } as never)).toBe(14)
  })
})

describe('resume preset fallback', () => {
  it.each(['removed', 'broken'] as const)('falls back to the registry default when the recorded preset is %s', async state => {
    let mounted: string | undefined
    const ctx = fakeContext({
      get: (key: string) => key === 'agentPresets'
        ? {
          defaultId: 'standard',
          list: async () => [],
          resolve: async () => {
            if (state === 'removed') throw new Error('Unknown agent preset: gone')
            return { id: 'gone', broken: 'missing plugin' }
          },
          mount: async (_ctx: unknown, preset?: string) => { mounted = preset },
          select: async () => 'standard',
          composedPreset: () => undefined,
        }
        : undefined,
      agents: {
        resume: async (options: unknown) => {
          const candidate = options as {
            resumeSessionId: ReturnType<typeof SessionId>
            setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
          }
          const handle = fakeHandle(candidate.resumeSessionId, [
            { type: 'agent-preset/selected', data: { agentPreset: 'gone' } },
          ])
          await candidate.setup?.({ on: vi.fn(() => () => {}) }, handle.agent)
          return handle
        },
      },
    })
    await resumeHostSession(ctx, SessionId('session-gone'))
    expect(mounted).toBe('standard')
  })
})
