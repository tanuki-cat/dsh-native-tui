import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.js'
import { contextWindowTokens, projectedContextTokens, type ContextMeterReading, type ContextPressureState } from './metrics.js'
import { NATIVE_TUI_SESSION_ID_PREFIX } from './session-list.js'

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

/** Read the latest durable model selection recorded in a Session. */
export function sessionModelSelection(session: Session): ModelSelection | undefined {
  let selection: ModelSelection | undefined
  for (const event of session.snapshotEvents()) {
    const type = (event.type as string)
    const data = event.data as Record<string, unknown>
    if (type === 'model/selection') {
      if (typeof data.provider === 'string' && typeof data.model === 'string' && data.provider !== '' && data.model !== '') {
        selection = {
          provider: data.provider,
          model: data.model,
          ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort as ModelSelection['reasoningEffort'] } : {}),
        }
      }
    }
    else if (type === 'request/header') {
      const header = data.header as { readonly config?: Record<string, unknown> } | undefined
      const config = header?.config
      if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string' && config.provider !== '' && config.model !== '') {
        selection = {
          provider: config.provider,
          model: config.model,
          ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort as ModelSelection['reasoningEffort'] } : {}),
        }
      }
    }
  }
  return selection
}

/** Read the latest persisted Agent preset for a Session. */
export function sessionAgentPreset(session: Session): string | undefined {
  const selected = session.snapshotEvents()
    .filter(event => (event.type as string) === 'agent-preset/selected')
    .at(-1)
  const selectedId = (selected?.data as { readonly agentPreset?: unknown } | undefined)?.agentPreset
  return typeof selectedId === 'string' ? selectedId : session.header.agentPreset
}

/** Projection reads narrowed to the one key the context segment needs. */
export interface ContextPressureReader {
  stateOf(session: Session, key: string): unknown
}

/**
 * Read the token meter's context state through its projections. The automatic
 * compactor prices the same surface, so the status bar must report this number
 * to stay aligned with it. `projectedContextTokens` anchors the last provider
 * sample and adds the surface movement since it, which is the occupancy the
 * NEXT request will pay.
 *
 * State presence separates the two silences: an unregistered projection reads
 * as `undefined` and leaves the log's last prompt standing in, while a mounted
 * unit publishes its state from the first fold (`surfaceTokens: 0`) and has no
 * sample to price yet — the reading is then empty, and the status row says so
 * instead of reporting an occupancy nobody measured.
 * @param projections - live Session projections, or undefined when unmounted.
 * @param session - session whose meter state and newest request header are read.
 * @param fallbackReservedTokens - adapter default used when no envelope declared a cap.
 * @returns the routed capacity and the reading, either possibly undefined.
 */
export function readContextMeter(
  projections: ContextPressureReader | undefined,
  session: Session,
  fallbackReservedTokens: number | undefined,
): { readonly window: number | undefined; readonly reading: ContextMeterReading | undefined } {
  const state = projections?.stateOf(session, 'contextPressure') as ContextPressureState | undefined
  if (state === undefined || state === null || typeof state !== 'object') return { window: undefined, reading: undefined }
  const tokens = projectedContextTokens(state)
  const reserved = sessionReservedCompletionTokens(session) ?? fallbackReservedTokens
  return {
    window: contextWindowTokens(state),
    reading: {
      ...(tokens === undefined ? {} : { tokens }),
      ...(reserved === undefined ? {} : { reservedTokens: reserved }),
    },
  }
}

/**
 * Output tokens the newest routed request envelope reserves, as the automatic
 * compactor deducts them: an envelope's own cap wins over the adapter's
 * per-request default, which only stands in when the envelope omitted one. The
 * header fold is incremental, so this costs only the events appended since the
 * last read.
 * @param session - Session whose latest request header is read.
 * @returns the cap in tokens, or undefined when no envelope declared one.
 */
export function sessionReservedCompletionTokens(session: Session): number | undefined {
  const cap = session.requestHeader()?.config.maxTokens
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined
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
  const sessionId = SessionId(config.sessionId ?? NATIVE_TUI_SESSION_ID_PREFIX + randomUUID())
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
          await presets.mount(agentCtx, sessionAgentPreset(agent.session) ?? presets.defaultId)
        },
      }),
  })
  return wrap(handle)
}
