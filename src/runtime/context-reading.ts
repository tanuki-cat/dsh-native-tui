import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { readContextMeter, type ContextPressureReader } from './agent.js'
import { effectiveThreshold, sameRoute, type CompactionPolicy, type ModelRoute } from './compaction-policy.js'
import { mountedCompactionPolicy } from './compaction-settings.js'
import type { CompactionReading, SessionStats } from './metrics.js'

/**
 * Incrementally collects new session events without cloning and freezing the whole log on each repaint.
 *
 * `eventAt` and `snapshotEvents` are the only synchronous event reads the
 * installed `dsh-session` exposes, and both are marked deprecated in favor of
 * awaiting Host event reads. No drop-in replacement ships yet, so this cursor
 * keeps the incremental reads until the Host migration lands.
 */
export class SessionEventCursor {
  private session: Agent['session'] | undefined
  private events: SessionEvent[] = []

  read(session: Agent['session']): readonly SessionEvent[] {
    const live = session as Agent['session'] & { seq?: number; eventAt?(seq: number): SessionEvent | undefined }
    if (typeof live.seq === 'number' && typeof live.eventAt === 'function') {
      if (this.session !== session || live.seq < this.events.length) {
        this.session = session
        this.events = []
      }
      for (let index = this.events.length; index < live.seq; index += 1) {
        const event = live.eventAt(index)
        if (event !== undefined) this.events.push(event)
      }
      return this.events
    }
    return session.snapshotEvents()
  }
}

interface ModelBudget {
  readonly window: number | undefined
  readonly reserved: number | undefined
}

interface ModelInfoReader {
  resolveModelInfo(provider: string, model: string): Promise<{
    readonly context?: { readonly contextWindow?: number }
    readonly defaultMaxTokens?: number
  }>
}

const routeKey = (route: ModelRoute): string => JSON.stringify([route.provider, route.model])

/** Adapter fallbacks keyed by route, so a pending model selection cannot price the old header. */
export class ContextModelBudgets {
  private readonly budgets = new Map<string, ModelBudget>()
  private readonly requests = new Map<string, object>()

  get(route: ModelRoute | undefined): ModelBudget | undefined {
    return route === undefined ? undefined : this.budgets.get(routeKey(route))
  }

  remember(route: ModelRoute, window: number | undefined, reserved: number | undefined): void {
    const key = routeKey(route)
    this.requests.delete(key)
    this.budgets.set(key, { window, reserved })
  }

  async refresh(llm: ModelInfoReader, route: ModelRoute | undefined, force: boolean): Promise<void> {
    if (route === undefined) return
    const key = routeKey(route)
    if (!force && (this.budgets.has(key) || this.requests.has(key))) return
    const ticket = {}
    this.requests.set(key, ticket)
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      if (this.requests.get(key) === ticket) this.remember(route, info.context?.contextWindow, info.defaultMaxTokens)
    } catch {
      // The last known capacity still describes this route while the catalogue is unavailable.
    } finally {
      if (this.requests.get(key) === ticket) this.requests.delete(key)
    }
  }
}

export function readContextInputs(
  host: Context,
  agent: Agent,
  selected: ModelRoute | undefined,
  budgets: ContextModelBudgets,
  cursor?: SessionEventCursor,
) {
  const session = agent.session
  const projections = host.get('sessionProjections') as ContextPressureReader | undefined
  const values = projections?.snapshot(session, ['contextPressure', 'contextBreakdown', 'sessionStats']).values
  const header = session.requestHeader()?.config
  const route = header ?? selected
  const catalog = budgets.get(route)
  const request = session.requestContext()
  const requestWindow = sameRoute(request, route) ? request?.contextWindow : undefined
  const meter = readContextMeter(projections, session, catalog?.reserved, values)
  // Host pressure uses the catalogue capacity. The last routed request supplies a fallback.
  const routedWindow = catalog?.window ?? requestWindow
  const window = routedWindow ?? (request === undefined ? meter.window : undefined)
  const reserved = header?.maxTokens ?? (catalog === undefined ? undefined : catalog.reserved ?? 0)
  const policy = route === undefined ? undefined : mountedCompactionPolicy(host, agent, route)
  const compaction = readActiveThreshold(policy, route, routedWindow, reserved)
  const selectedPolicy = selected === undefined || sameRoute(selected, route) ? policy : mountedCompactionPolicy(host, agent, selected)
  const compactionBaselinePercent = selectedPolicy?.auto && selectedPolicy.hasModelThreshold ? selectedPolicy.ratio * 100 : undefined
  return { projections, meter, window, compaction, compactionBaselinePercent, values,
    stats: values?.sessionStats as SessionStats | undefined,
    events: cursor === undefined ? session.snapshotEvents() : cursor.read(session) }
}

function readActiveThreshold(
  policy: CompactionPolicy | undefined, route: ModelRoute | undefined, window: number | undefined, reserved: number | undefined,
): CompactionReading {
  if (route === undefined) return { state: 'unknown' }
  const label = route.provider + '/' + route.model
  if (policy === undefined) return { state: 'unknown', route: label }
  if (!policy.auto) return { state: 'disabled', route: label }
  const tokens = window === undefined || reserved === undefined ? undefined : effectiveThreshold(policy, { window, reserved })
  if (tokens === undefined || window === undefined) return { state: 'unknown', route: label }
  return {
    state: 'known', route: label, tokens, window, percent: tokens / window * 100,
    ...(policy.hasModelThreshold ? { configuredPercent: policy.ratio * 100 } : {}),
  }
}
