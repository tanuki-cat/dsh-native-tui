import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHostSession, resumeHostSession, sessionAgentPreset, sessionModelSelection } from '../src/runtime/agent.js'
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