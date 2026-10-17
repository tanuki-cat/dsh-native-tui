import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.js'

/** One live Host Agent and its owned handle. */
export interface HostSession {
  readonly id: SessionId
  readonly agent: Agent
  readonly handle: AgentHandle
  dispose(): Promise<void>
}

/** One preset roster row exposed by the Host registry. */
export interface AgentPresetRow {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: unknown
}

/** Host Agent-preset registry contract used by the terminal entry. */
export interface AgentPresetService {
  readonly defaultId: string
  list(): Promise<readonly AgentPresetRow[]>
  resolve(id?: string): Promise<{ readonly id: string; readonly broken?: unknown }>
  mount(ctx: Context, id?: string): Promise<unknown>
  select(agent: Agent, id: string): Promise<string>
  composedPreset(ctx: Context): string | undefined
}

function presetsOf(ctx: Context): AgentPresetService | undefined {
  return ctx.get('agentPresets') as AgentPresetService | undefined
}

function defaultSelection(ctx: Context): ModelSelection {
  const configured = ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
  return configured?.currentSelection() ?? { provider: 'deepseek-official', model: 'deepseek-flash' }
}

async function wrap(handle: AgentHandle): Promise<HostSession> {
  const agent = handle.agent
  return {
    id: agent.id,
    agent,
    handle,
    dispose: async () => {
      if (agent.status === 'running') agent.cancel({ kind: 'user' })
      await handle.dispose()
    },
  }
}

/**
 * Create one fresh root Agent in the requested workspace.
 * @param ctx - Host context carrying the agent factory and preset registry.
 * @param config - terminal configuration.
 * @returns the owned Agent handle.
 */
export async function createHostSession(ctx: Context, config: ResolvedConfig): Promise<HostSession> {
  const sessionId = SessionId(config.sessionId ?? 'native-tui-' + randomUUID())
  const presets = presetsOf(ctx)
  const preset = presets === undefined ? undefined : await presets.resolve(config.agentPreset)
  const handle = await ctx.agents.create({
    sessionId,
    meta: {
      cwd: config.cwd,
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
    },
    agentOptions: defaultSelection(ctx),
    ...(preset === undefined || presets === undefined
      ? {}
      : {
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, preset.id)
        },
      }),
  })
  return wrap(handle)
}

/**
 * Resume one persisted Session as the active root Agent.
 * @param ctx - Host context carrying persistence, the agent factory, and presets.
 * @param id - persisted Session identity.
 * @returns the owned Agent handle.
 */
export async function resumeHostSession(ctx: Context, id: SessionId): Promise<HostSession> {
  const presets = presetsOf(ctx)
  const handle = await ctx.agents.resume({
    resumeSessionId: id,
    ...(presets === undefined
      ? {}
      : {
        setup: async (agentCtx: Context, agent: Agent) => {
          const selected = agent.session.snapshotEvents()
            .filter(event => (event.type as string) === 'agent-preset/selected')
            .at(-1)
          const selectedId = (selected?.data as { readonly agentPreset?: unknown } | undefined)?.agentPreset
          const presetId = typeof selectedId === 'string'
            ? selectedId
            : agent.session.header.agentPreset ?? presets.defaultId
          await presets.mount(agentCtx, presetId)
        },
      }),
  })
  return wrap(handle)
}
