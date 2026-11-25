import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import {
  compactionShadowedSeqs,
  contextBreakdown,
  contextWindowTokens,
  projectedContextTokens,
  rebaseComposition,
  type ContextBreakdown,
  type ContextBreakdownState,
  type ContextMeterReading,
  type ContextPressureState,
} from './metrics.js'
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
  snapshot(session: Session, keys?: readonly string[]): { readonly values: Readonly<Record<string, unknown>> }
}

/**
 * Read the token meter's context state through its projections. The automatic
 * compactor prices the same surface. The public projectedTokens value includes
 * surface changes since the last provider sample, so no local delta fold is needed.
 *
 * State presence separates the two silences: an unregistered projection reads
 * as `undefined` and leaves the log's last prompt standing in, while a mounted
 * unit publishes an initially empty view and has no
 * sample to price yet — the reading is then empty, and the status row says so
 * instead of reporting an occupancy nobody measured.
 * @param projections - live Session projections, or undefined when unmounted.
 * @param session - session whose meter state and newest request header are read.
 * @param fallbackReservedTokens - adapter default used when no envelope declared a cap.
 * @param values - already-read scoped snapshot, shared with the status and composition readers.
 * @returns the routed capacity and the reading, either possibly undefined.
 */
export function readContextMeter(
  projections: ContextPressureReader | undefined,
  session: Session,
  fallbackReservedTokens: number | undefined,
  values?: Readonly<Record<string, unknown>>,
): { readonly window: number | undefined; readonly reading: ContextMeterReading | undefined } {
  const state = (values ?? projections?.snapshot(session, ['contextPressure']).values)?.contextPressure as ContextPressureState | undefined
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
 * Heuristic tokens of the reasoning the provider never receives.
 *
 * pi-ai replays a `thinking` block only when it carries a `thinkingSignature`;
 * a block without one is dropped from the request entirely. Gateways that stream
 * reasoning without a signature (this profile's does) therefore leave the meter
 * pricing text the next request does not carry, and since that pricing is folded
 * into `messageTokens`, that bucket ends up claiming more context than the
 * session is billed for.
 *
 * Returned as an absolute figure on purpose: the caller subtracts it from the
 * projection's own `messageTokens`, so the numerator and the denominator are
 * priced the same way and no third estimator has to agree with the meter's.
 * @param session - session whose surface is read.
 * @returns heuristic tokens of unreplayable reasoning; 0 when all of it replays.
 */
export function unreplayedReasoningTokens(session: Session): number {
  // The meter's fixed estimator: 4 characters per token plus 4 per block.
  const price = (text: string): number => Math.ceil(text.length / 4) + 4
  const events = session.snapshotEvents()
  // Compaction replaced surface nodes stay in the durable log but no longer
  // reach the provider, so pricing them would overstate the message bucket.
  const shadowed = compactionShadowedSeqs(events)
  let tokens = 0
  for (const event of events) {
    const seq = Number(event.seq)
    if (Number.isSafeInteger(seq) && shadowed.has(seq)) continue
    const type = event.type as string
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
    const message = (event.data as { readonly message?: { readonly role?: unknown; readonly content?: readonly unknown[] } }).message
    if (message?.role === 'system' || !Array.isArray(message?.content)) continue
    for (const block of message.content) {
      const candidate = block as { readonly type?: unknown; readonly text?: unknown; readonly thinkingSignature?: unknown }
      if (candidate.type !== 'reasoning' || typeof candidate.text !== 'string') continue
      if (candidate.thinkingSignature === undefined) tokens += price(candidate.text)
    }
  }
  return tokens
}

/**
 * Read the token meter's heuristic composition of the next request's context.
 *
 * A separate projection from {@link readContextMeter} on purpose: the meter
 * prices the composition with its fixed estimator, while the occupancy figure is
 * anchored to the provider's own usage, so the two never sum to each other.
 *
 * The projection's composition is rebased onto the provider's own prompt count
 * so no bucket can exceed the total: its estimator prices reasoning the request
 * never carries, which on a real session pushed one bucket past the occupancy.
 * @param projections - live Session projections, or undefined when unmounted.
 * @param session - session whose breakdown state is read.
 * @param occupancyTokens - provider-anchored occupancy to rebase the split onto.
 * @param values - the scoped snapshot used for the matching occupancy reading.
 * @returns the three buckets, or undefined when the meter is not mounted.
 */
export function readContextBreakdown(
  projections: ContextPressureReader | undefined,
  session: Session,
  occupancyTokens?: number,
  values?: Readonly<Record<string, unknown>>,
): ContextBreakdown | undefined {
  const state = (values ?? projections?.snapshot(session, ['contextBreakdown']).values)?.contextBreakdown as ContextBreakdownState | undefined
  const raw = contextBreakdown(state)
  if (raw === undefined) return undefined
  return rebaseComposition(raw, occupancyTokens, unreplayedReasoningTokens(session)) ?? raw
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
  /**
   * One disposal for every caller: the terminal, a reload, and a restart can
   * all release the same Agent, and a failed disposal stays retryable.
   */
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    if (agent.status === 'running') agent.cancel({ kind: 'user' })
    disposal = handle.dispose().catch((error: unknown) => {
      disposal = undefined
      throw error
    })
    return disposal
  }
  return { id: agent.id, agent, handle, dispose }
}

/** Treat a blank startup string as unset so an empty profile value cannot reach the Host. */
function startupValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Create one fresh root Agent in the requested workspace.
 * @param ctx - Host context carrying the agent factory and preset registry.
 * @param config - terminal configuration.
 * @returns the owned Agent handle.
 */
export async function createHostSession(ctx: Context, config: ResolvedConfig): Promise<HostSession> {
  const sessionId = SessionId(startupValue(config.sessionId) ?? NATIVE_TUI_SESSION_ID_PREFIX + randomUUID())
  const cwd = startupValue(config.cwd)
  const presets = presetsOf(ctx)
  const preset = presets === undefined ? undefined : await presets.resolve(startupValue(config.agentPreset))
  const handle = await ctx.agents.create({
    sessionId,
    meta: {
      cwd: cwd === undefined ? process.cwd() : resolve(cwd),
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
    },
    agentOptions: defaultSelection(ctx),
    setup: async (agentCtx: Context) => {
      installModelSelection(agentCtx)
      if (preset !== undefined && presets !== undefined) await presets.mount(agentCtx, preset.id)
    },
  })
  return wrap(handle)
}

/** Release the idle Agent and its owned resources before restoring the same Session; failed disposal never starts a replacement. */
export async function restartHostSession(
  ctx: Context,
  current: HostSession,
  onDisposed?: () => void,
): Promise<HostSession> {
  if (current.agent.status === 'running') throw new Error('Wait for the running turn to finish or cancel it before resetting shells.')
  await current.dispose()
  onDisposed?.()
  return resumeHostSession(ctx, current.id)
}

/**
 * Restore the persisted preset, falling back to the registry default when the
 * recorded identity was removed (or its mounted revision is broken) after the
 * Session was written.
 * @param presets - Host preset registry.
 * @param agent - resumed Agent carrying the durable selection.
 * @returns the preset to mount.
 */
async function restoredPreset(presets: AgentPresetService, agent: Agent): Promise<string> {
  const persisted = sessionAgentPreset(agent.session)
  if (persisted === undefined || persisted.trim() === '') return presets.defaultId
  try {
    const resolved = await presets.resolve(persisted)
    return resolved.broken === undefined ? resolved.id : presets.defaultId
  }
  catch {
    return presets.defaultId
  }
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
    agentOptions: defaultSelection(ctx),
    setup: async (agentCtx: Context, agent: Agent) => {
      installModelSelection(agentCtx)
      if (presets !== undefined) await presets.mount(agentCtx, await restoredPreset(presets, agent))
    },
  })
  return wrap(handle)
}
