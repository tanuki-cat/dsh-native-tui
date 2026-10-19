import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHostSession, readContextMeter, resumeHostSession, sessionAgentPreset, sessionModelSelection, sessionReservedCompletionTokens } from '../src/runtime/agent.js'
import type { ResolvedConfig } from '../src/config.js'

const config: ResolvedConfig = {
  sessionId: undefined,
  cwd: '/tmp/workspace',
  showReasoning: true,
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

describe('session selection restore', () => {
  it('reads the latest model/effort and preset from Session events', () => {
    const session = {
      header: { cwd: '/tmp', createdAt: 0, agentPreset: 'header-preset' },
      snapshotEvents: () => [
        { type: 'model/selection', data: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } },
        { type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2', reasoningEffort: 'high' } } } },
        { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } },
      ],
    }
    expect(sessionModelSelection(session as never)).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'high' })
    expect(sessionAgentPreset(session as never)).toBe('ptc')
  })
})

describe('context meter reading', () => {
  const state = { pressureTokens: 300_000, surfaceTokens: 400_000, sampledSurfaceTokens: 280_000, contextWindow: 1_000_000 }
  const projections = { stateOf: () => state }

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
    expect(readContextMeter({ stateOf: () => undefined }, session as never, 32_768))
      .toEqual({ window: undefined, reading: undefined })
    expect(readContextMeter(undefined, session as never, undefined))
      .toEqual({ window: undefined, reading: undefined })
  })

  it('keeps the reserved figure while the meter has no sample yet', () => {
    const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 100_000 } }) }
    expect(readContextMeter({ stateOf: () => ({ surfaceTokens: 0 }) }, session as never, undefined).reading)
      .toEqual({ reservedTokens: 100_000 })
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
          await candidate.setup?.({}, {})
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
          await candidate.setup?.({}, handle.agent)
          return handle
        },
      },
    })
    await resumeHostSession(ctx, id)
    expect(mounted).toBe('minimal')
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
    expect(captured).toEqual({ resumeSessionId: id })
    expect(session.id).toBe(id)
  })
})