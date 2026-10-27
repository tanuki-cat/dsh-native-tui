import { assistantStreamFirstTokenTime, lastAssistantStreamChunk, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/**
 * Compaction pressure defaults, mirroring `@deepseek-ai/dsh-compaction-basic`
 * (thresholdRatio, headroomTokens). The status bar keeps a Web-identical
 * percentage of the model window and states this trigger point beside it, so a
 * profile that overrides those keys shifts only the stated trigger point.
 */
export const COMPACTION_THRESHOLD_RATIO = 0.8
export const COMPACTION_HEADROOM_TOKENS = 65_536

/** Shape of the token-meter's `contextPressure` projection state. */
export interface ContextPressureState {
  readonly contextWindow?: unknown
  readonly pressureTokens?: unknown
  readonly surfaceTokens?: unknown
  readonly sampledSurfaceTokens?: unknown
}

/**
 * Route capacity recorded on the latest request envelope.
 * @param state - the `contextPressure` state, or undefined when unregistered.
 * @returns the window the request declared, or undefined before one was routed.
 */
export function contextWindowTokens(state: ContextPressureState | undefined): number | undefined {
  const window = state?.contextWindow
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? Math.round(window) : undefined
}

/**
 * Occupancy the token meter expects the NEXT request to pay, from its raw
 * projection state. `SessionProjections.stateOf` returns host state rather than
 * the wire view, so the view's own formula lives here: the newest provider
 * sample plus the surface's movement since that sample was taken.
 * @param state - the `contextPressure` state, or undefined when unregistered.
 * @returns estimated tokens, or undefined before the first usage sample.
 */
export function projectedContextTokens(state: ContextPressureState | undefined): number | undefined {
  const pressure = state?.pressureTokens
  const surface = state?.surfaceTokens
  const sampled = state?.sampledSurfaceTokens
  if (typeof pressure !== 'number') return undefined
  if (typeof surface !== 'number' || typeof sampled !== 'number') return Math.max(0, Math.round(pressure))
  return Math.max(0, Math.round(pressure + surface - sampled))
}

/**
 * Shape of the token-meter's `contextBreakdown` projection state.
 *
 * The counts sit under `breakdown`: the unit keeps its surviving system prompts
 * and a surface total alongside them, and only its client view flattens the
 * three figures. `SessionProjections.stateOf` returns that raw state, so the
 * nested shape is what this reader has to accept.
 */
export interface ContextBreakdownState {
  readonly breakdown?: {
    readonly systemTokens?: unknown
    readonly toolsTokens?: unknown
    readonly messageTokens?: unknown
  }
}

/** Heuristic composition of the next request's context, in estimator tokens. */
export interface ContextBreakdown {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
  /**
   * Set when the projection's own figures could not be trusted and the buckets
   * were rebuilt: why, for the report to state.
   */
  readonly rebuilt?: 'out-of-scale'
}

/**
 * One bucket's share of the heuristic total, in tenths of a percent.
 *
 * Integer tenths rather than whole percent because a real composition is
 * lopsided: a 628-token tool schema against a 51K system prompt is 1.2%, and
 * rounding to whole percent would print 0% next to a bucket that visibly owns a
 * bar segment. The three figures always sum to 1000, so the printed column adds
 * up to exactly 100.0%.
 */
export interface ContextCompositionShares {
  readonly system: number
  readonly tools: number
  readonly messages: number
}

function asTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Read the token meter's heuristic composition from its raw projection state.
 *
 * These three figures use the meter's fixed density estimate, so they will not
 * sum to the provider-anchored occupancy: the estimator underprices CJK text and
 * JSON schemas, which is exactly the error anchoring keeps out of the total.
 * Present them as a composition of the surface, never as the occupancy itself.
 * @param state - the `contextBreakdown` state, or undefined when unregistered.
 * @returns the three buckets, or undefined when the projection is unmounted.
 */
export function contextBreakdown(state: ContextBreakdownState | undefined): ContextBreakdown | undefined {
  if (state === undefined || state === null || typeof state !== 'object') return undefined
  const counts = state.breakdown
  return {
    systemTokens: asTokens(counts?.systemTokens),
    toolsTokens: asTokens(counts?.toolsTokens),
    messageTokens: asTokens(counts?.messageTokens),
  }
}

/**
 * Rebase a composition onto the provider's own prompt count.
 *
 * The projection prices the surface with a fixed 4-chars-per-token estimate and
 * counts every retained node, including `reasoning` blocks. Measured against a
 * real session those two choices compound badly: reasoning is priced at ~42% of
 * the surface but is only replayed to the provider when it carries a
 * `thinkingSignature`, and this profile's blocks carry none — so the estimate
 * drifts away from the occupancy instead of tracking it, and a single bucket ends
 * up larger than the total the provider billed.
 *
 * Two corrections keep the parts inside the whole:
 * 1. `unreplayedTokens` comes off `messageTokens`, because the request never
 *    carries that reasoning. Subtracting an absolute figure keeps the numerator
 *    and the denominator priced by the same estimator; only the reasoning leaves
 *    the bucket — the rest of the messages still enter the request, so weighting
 *    the whole bucket would collapse every remaining token into the system prompt.
 * 2. The remainder is scaled so the buckets sum to `occupancyTokens`, which
 *    preserves the estimator's `proportions` while giving them the provider's
 *    magnitude. Proportions are what the panel is for; the absolute figure is
 *    the occupancy line's job.
 * @param breakdown - buckets as the projection priced them.
 * @param occupancyTokens - provider-anchored occupancy to rebase onto.
 * @param unreplayedTokens - heuristic tokens of reasoning the request drops.
 * @returns rebucketed figures summing to the occupancy, or undefined to keep the
 *   projection's own figures when there is nothing to rebase onto.
 */
export function rebaseComposition(
  breakdown: ContextBreakdown,
  occupancyTokens: number | undefined,
  unreplayedTokens = 0,
): ContextBreakdown | undefined {
  if (occupancyTokens === undefined || !Number.isFinite(occupancyTokens) || occupancyTokens <= 0) return undefined
  const unreplayed = Number.isFinite(unreplayedTokens) ? Math.max(0, unreplayedTokens) : 0
  const weights = [
    breakdown.systemTokens,
    breakdown.toolsTokens,
    Math.max(0, breakdown.messageTokens - unreplayed),
  ]
  const total = weights.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return undefined
  // Largest-remainder apportionment onto the anchored total keeps the integer
  // buckets summing to exactly the occupancy, with no rounding drift.
  const exact = weights.map(weight => weight / total * occupancyTokens)
  const units = exact.map(value => Math.floor(value))
  let remaining = Math.round(occupancyTokens) - units.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - (units[index] ?? 0) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const entry of byRemainder) {
    if (remaining <= 0) break
    units[entry.index] = (units[entry.index] ?? 0) + 1
    remaining -= 1
  }
  return {
    systemTokens: units[0] ?? 0,
    toolsTokens: units[1] ?? 0,
    messageTokens: units[2] ?? 0,
    rebuilt: 'out-of-scale',
  }
}

/**
 * Split a total into integer units that sum to it, proportional to the weights.
 *
 * Largest-remainder apportionment: floor everything, then spend the leftover
 * units on the largest fractional parts (ties by bucket order). Rounding each
 * bucket on its own would let a three-way split read 33.3/33.3/33.3 or 100.0/0/
 * 0, and the printed column would then contradict the bar drawn beside it.
 * @param weights - non-negative bucket sizes.
 * @param total - units to apportion.
 * @returns one unit count per bucket, summing to `total` whenever `total` allows.
 */
function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map(weight => weight / sum * total)
  const units = exact.map(value => Math.floor(value))
  let remaining = total - units.reduce((acc, value) => acc + value, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - (units[index] ?? 0) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const entry of byRemainder) {
    if (remaining <= 0) break
    units[entry.index] = (units[entry.index] ?? 0) + 1
    remaining -= 1
  }
  return units
}

/**
 * Share of each composition bucket, in tenths of a percent summing to 1000.
 * @param breakdown - heuristic composition.
 * @returns per-bucket tenths; all zero for an empty composition.
 */
export function contextCompositionShares(breakdown: ContextBreakdown): ContextCompositionShares {
  const [system = 0, tools = 0, messages = 0] = apportion(
    [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens],
    1_000,
  )
  return { system, tools, messages }
}

/**
 * Render one share as `82.4%`.
 * @param tenths - tenths of a percent from {@link contextCompositionShares}.
 * @returns the percentage with one decimal, which keeps 0.1 distinct from 0.
 */
export function formatSharePercent(tenths: number): string {
  const whole = Math.floor(tenths / 10)
  return String(whole) + '.' + String(tenths % 10) + '%'
}

/** Context occupancy next to the compaction trigger, all as shares of the window. */
export interface ContextPressure {
  /** Estimated model-visible tokens (surface + tools + system prompt). */
  readonly estimateTokens: number
  /** Estimated tokens that trigger automatic compaction. */
  readonly thresholdTokens: number
  /** Share of the model window already used, clamped to 0-100. */
  readonly percent: number
  /** Share of the model window at which automatic compaction fires. */
  readonly compactPercent: number
}

/**
 * Token budget for one routed model, as the automatic compactor prices it.
 * @param contextWindow - the model's declared capacity.
 * @param reservedCompletionTokens - output tokens one request reserves.
 * @returns the estimate at which compaction runs.
 */
export function compactionThresholdTokens(contextWindow: number, reservedCompletionTokens = 0): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  const messageBudget = contextWindow - Math.max(0, Math.floor(reservedCompletionTokens))
  const pressureBudget = messageBudget - COMPACTION_HEADROOM_TOKENS
  // A reserve that leaves no pressure budget is a misconfiguration the compactor
  // rejects outright; report the nominal ratio rather than a 1-token threshold.
  const threshold = pressureBudget > 0
    ? Math.min(contextWindow * COMPACTION_THRESHOLD_RATIO, pressureBudget)
    : contextWindow * COMPACTION_THRESHOLD_RATIO
  return Math.max(1, Math.floor(threshold))
}

/**
 * Price one context against the automatic compaction point.
 * @param contextWindow - the model's declared capacity.
 * @param reservedCompletionTokens - output tokens one request reserves.
 * @param estimateTokens - estimated model-visible tokens right now.
 * @returns the estimate, its threshold, and the share used.
 */
export function contextPressure(
  contextWindow: number,
  reservedCompletionTokens: number,
  estimateTokens: number,
): ContextPressure | undefined {
  const thresholdTokens = compactionThresholdTokens(contextWindow, reservedCompletionTokens)
  if (thresholdTokens <= 0) return undefined
  const estimate = Math.max(0, Math.round(estimateTokens))
  return {
    estimateTokens: estimate,
    thresholdTokens,
    percent: Math.round(Math.min(1, estimate / contextWindow) * 100),
    compactPercent: Math.min(100, Math.round(thresholdTokens / contextWindow * 100)),
  }
}

/** Whole-session counters published by the official session-stats projection. */
export interface SessionStats {
  readonly turns: number
  readonly steps: number
  readonly decodeMs: number
  readonly decodeTokens: number
}

/** Metrics rendered in the terminal status line. */
export interface SessionMetrics {
  readonly turns: number
  readonly steps: number
  readonly tokensPerSecond?: number
  readonly totalTokens: number
  /**
   * Cache-hit share of prompt-side input, formatted as the Web chat formats it;
   * absent when the session billed no prompt input.
   */
  readonly cacheHit?: string
  /** Share of the model window already used, matching the Web context meter. */
  readonly contextPercent?: number
  /** Estimated model-visible tokens the percentage was computed from. */
  readonly contextEstimateTokens?: number
  /** Model window the percentage divides by. */
  readonly contextWindowTokens?: number
  /** Share of the window at which automatic compaction fires. */
  readonly contextCompactPercent?: number
}

/**
 * The token meter's context reading, taken from the host `contextPressure`
 * projection.
 *
 * Passing the reading at all means the meter is mounted, so the meter owns the
 * context segment: before a provider reports usage there is nothing to price,
 * and the figures stay unknown instead of falling back to the log — the same
 * reason the Web meter renders nothing until a sample exists. Compositions
 * without the meter omit the argument, and the durable log's last prompt stands
 * in as the only estimate available.
 */
export interface ContextMeterReading {
  /** Estimated model-visible tokens the next request pays; absent before the first provider sample. */
  readonly tokens?: number
  /** Output tokens one request reserves, which the compactor deducts from its budget. */
  readonly reservedTokens?: number
}

function usageNumber(usage: Record<string, unknown>, key: string): number {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Narrow one provider usage record, or undefined when the settlement carries none. */
function asUsage(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Provider usage one durable settlement reports. Mirrors `usageOf` in
 * `@deepseek-ai/dsh-token-meter` (`usage-projection.js`): a message's own
 * `usage` first, then the last streamed chunk, because an interrupted attempt is
 * billed through its stream and would otherwise be dropped from both the total
 * and the cache share.
 * @param event - one durable Session event.
 * @returns the usage record, or undefined when this event reports none.
 */
function usageOf(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type === 'assistant/message') {
    return asUsage(event.data.usage) ?? streamUsage(event.data.stream)
  }
  if (event.type === 'assistant/attempt') return streamUsage(event.data.stream)
  return undefined
}

/** Usage carried by the last `usage` chunk of one compact settlement stream. */
function streamUsage(stream: readonly AssistantStreamRecord[] | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(stream)) return undefined
  return asUsage(lastAssistantStreamChunk(stream, 'usage')?.usage)
}

/** One settlement's disjoint provider buckets. */
interface UsageBuckets {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Round one cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: number): number {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/** Render exact percentage units at the requested precision. */
function displayPercentUnits(units: number, decimalPlaces: number): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : whole + '.' + String(tenths)
}

/**
 * Cache-hit share of prompt-side input, formatted as the Web chat formats it.
 *
 * A partial hit is never rounded up to 100: when ordinary precision would claim
 * a complete hit, the figure carries just enough extra precision to stay below
 * the true share (99.8, 99.99, …). Ported verbatim from `formatCacheHitPercent`
 * with its `roundedPercentUnits`/`displayPercentUnits` helpers in
 * `@deepseek-ai/dsh-client-ui-chat` (the Web stats pill) so both surfaces print
 * one number; keep the two in step when either moves. Callers that need
 * arithmetic use the raw counters instead.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTokens - prompt-side tokens the session billed.
 * @param decimalPlaces - ordinary ratio precision; 0 everywhere the pill is drawn.
 * @returns the percentage text without its sign, or undefined with no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens: number, promptTokens: number, decimalPlaces = 0): string | undefined {
  if (promptTokens === 0) return undefined
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  if (roundedUnits < (decimalPlaces === 0 ? 100 : 1_000)) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return '99.' + '9'.repeat(distinguishingPlaces - 1) + String(10 - roundedLoss)
}

/**
 * Fold provider usage records and official stats into status-bar metrics.
 * Turns/steps come from session-stats when present; the event fallback keeps
 * the line useful in compositions without that projection.
 * @param events - complete durable Session event log.
 * @param stats - optional whole-session sessionStats projection.
 * @param contextWindow - selected model context capacity, when known.
 * @param meter - the token meter's reading when that service is mounted;
 *   without it the latest provider prompt stands in, which lags the surface the
 *   compactor prices.
 * @returns cumulative token/cache figures and context pressure.
 */
export function collectSessionMetrics(
  events: readonly SessionEvent[],
  stats?: SessionStats,
  contextWindow?: number,
  meter?: ContextMeterReading,
): SessionMetrics {
  let turns = stats?.turns ?? 0
  let steps = stats?.steps ?? 0
  let buckets: UsageBuckets = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  /**
   * Slot of the newest settlement. The token meter lets a later report for the
   * same step replace the earlier one — a settled message replacing its own
   * attempt, or a retried attempt replacing its predecessor — so the fold keeps
   * that slot's buckets to subtract when the replacement arrives.
   */
  let settled: { readonly turn: unknown; readonly step: unknown; readonly buckets: UsageBuckets } | undefined
  let latestPromptTokens = 0
  /** Sequence of the newest provider sample, for deciding what a prune can subtract. */
  let latestUsageSeq: number | undefined
  /** Event-log decode totals when the sessionStats projection is not mounted. */
  let fallbackDecodeMs = 0
  let fallbackDecodeTokens = 0
  for (const event of events) {
    if (stats === undefined && event.type === 'turn/start') turns += 1
    if (stats === undefined && event.type === 'step/end') steps += 1
    if ((event.type as string) === 'compaction/summary' || (event.type as string) === 'compaction/prune') {
      // Only shadowed events that were already in the latest provider sample
      // can be subtracted from that sample. A tool result created after the
      // sample was never priced there; subtracting it would understate context.
      const data = event.data as {
        readonly shadowedTokenCount?: unknown
        readonly shadowedSeqs?: unknown
        readonly shadowedRange?: { readonly end?: unknown }
      }
      const shadowedSeqs = Array.isArray(data.shadowedSeqs)
        ? data.shadowedSeqs.filter((seq): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq))
        : []
      const shadowedEnd = shadowedSeqs.length > 0
        ? Math.max(...shadowedSeqs)
        : typeof data.shadowedRange?.end === 'number' ? data.shadowedRange.end : undefined
      const shadowed = data.shadowedTokenCount
      if (latestUsageSeq !== undefined && shadowedEnd !== undefined && shadowedEnd <= latestUsageSeq
        && typeof shadowed === 'number' && Number.isFinite(shadowed) && shadowed > 0) {
        latestPromptTokens = Math.max(0, latestPromptTokens - shadowed)
      }
      continue
    }
    if ((event.type as string) === 'llm/retry-started') {
      const retry = event.data as { readonly turn?: unknown; readonly step?: unknown }
      if (settled !== undefined && settled.turn === retry.turn && settled.step === retry.step) settled = undefined
      continue
    }
    const usage = usageOf(event)
    if (usage === undefined) continue
    if (stats === undefined && event.type === 'assistant/message') {
      const first = Array.isArray(event.data.stream)
        ? assistantStreamFirstTokenTime(event.data.stream)
        : undefined
      const output = usage.outputTokens
      if (first !== undefined && typeof output === 'number' && Number.isFinite(output) && output >= 0) {
        fallbackDecodeMs += Math.max(0, event.time - first)
        fallbackDecodeTokens += output
      }
    }
    const next: UsageBuckets = {
      input: usageNumber(usage, 'inputTokens'),
      output: usageNumber(usage, 'outputTokens'),
      cacheRead: usageNumber(usage, 'cacheReadTokens'),
      cacheWrite: usageNumber(usage, 'cacheWriteTokens'),
    }
    const slot = event.data as { readonly turn?: unknown; readonly step?: unknown }
    if (settled !== undefined && settled.turn === slot.turn && settled.step === slot.step) {
      buckets = {
        input: buckets.input - settled.buckets.input,
        output: buckets.output - settled.buckets.output,
        cacheRead: buckets.cacheRead - settled.buckets.cacheRead,
        cacheWrite: buckets.cacheWrite - settled.buckets.cacheWrite,
      }
    }
    buckets = {
      input: buckets.input + next.input,
      output: buckets.output + next.output,
      cacheRead: buckets.cacheRead + next.cacheRead,
      cacheWrite: buckets.cacheWrite + next.cacheWrite,
    }
    settled = { turn: slot.turn, step: slot.step, buckets: next }
    // The newest sample is the log's stand-in estimate, whatever slot it reports.
    latestPromptTokens = next.input + next.cacheRead + next.cacheWrite
    const sampleSeq = Number(event.seq)
    if (Number.isSafeInteger(sampleSeq)) latestUsageSeq = sampleSeq
  }
  const promptTokens = buckets.input + buckets.cacheRead + buckets.cacheWrite
  // The Web usage pill sums the four disjoint buckets, so a provider's own
  // total never enters the figure.
  const totalTokens = promptTokens + buckets.output
  const cacheHit = formatCacheHitPercent(buckets.cacheRead, promptTokens)
  const decodeMs = stats?.decodeMs ?? fallbackDecodeMs
  const decodeTokens = stats?.decodeTokens ?? fallbackDecodeTokens
  const tokensPerSecond = decodeMs > 0 && decodeTokens > 0
    ? decodeTokens / (decodeMs / 1000)
    : undefined
  // The compactor prices the surface the meter estimates, so a mounted meter
  // owns the figure — including its silence before the first provider sample.
  // Only a composition without the meter falls back to the log's last prompt,
  // which lags the surface the compactor prices.
  const estimateTokens = meter === undefined ? latestPromptTokens : meter.tokens
  const pressure = contextWindow === undefined || estimateTokens === undefined
    ? undefined
    : contextPressure(contextWindow, meter?.reservedTokens ?? 0, estimateTokens)
  return {
    turns,
    steps,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    totalTokens,
    ...(cacheHit === undefined ? {} : { cacheHit }),
    ...(pressure === undefined ? {} : {
      contextPercent: pressure.percent,
      contextEstimateTokens: pressure.estimateTokens,
      contextWindowTokens: contextWindow,
      contextCompactPercent: pressure.compactPercent,
    }),
  }
}

/**
 * Memoizing wrapper around {@link collectSessionMetrics}.
 *
 * The status row repaints on every durable Session event while the fold is
 * linear in the whole log, so a long session pays it thousands of times. The
 * Host hands out one frozen event snapshot per log length, so the array
 * identity changes exactly when the log does; the length is part of the key so
 * a caller that appends in place still misses.
 *
 * The projection and the meter are keyed by the values the fold reads rather
 * than by object identity: the Host may hand out a fresh state object per call,
 * and a new object with the same counters must not refold the log. The stats
 * presence is part of the key because the event fallback only runs when no
 * projection exists.
 * @returns a fold that returns the previous result while its inputs are equal.
 */
export function createSessionMetricsMemo(): (
  events: readonly SessionEvent[],
  stats?: SessionStats,
  contextWindow?: number,
  meter?: ContextMeterReading,
) => SessionMetrics {
  let last: {
    readonly events: readonly SessionEvent[]
    readonly length: number
    readonly hasStats: boolean
    readonly turns: number | undefined
    readonly steps: number | undefined
    readonly decodeMs: number | undefined
    readonly decodeTokens: number | undefined
    readonly contextWindow: number | undefined
    readonly tokens: number | undefined
    readonly reserved: number | undefined
    readonly metrics: SessionMetrics
  } | undefined
  return (events, stats, contextWindow, meter) => {
    if (last !== undefined
      && last.events === events
      && last.length === events.length
      && last.hasStats === (stats !== undefined)
      && last.turns === stats?.turns
      && last.steps === stats?.steps
      && last.decodeMs === stats?.decodeMs
      && last.decodeTokens === stats?.decodeTokens
      && last.contextWindow === contextWindow
      && last.tokens === meter?.tokens
      && last.reserved === meter?.reservedTokens) {
      return last.metrics
    }
    const metrics = collectSessionMetrics(events, stats, contextWindow, meter)
    last = {
      events,
      length: events.length,
      hasStats: stats !== undefined,
      turns: stats?.turns,
      steps: stats?.steps,
      decodeMs: stats?.decodeMs,
      decodeTokens: stats?.decodeTokens,
      contextWindow,
      tokens: meter?.tokens,
      reserved: meter?.reservedTokens,
      metrics,
    }
    return metrics
  }
}

/**
 * Compact token count used in the status bar, matching `formatTokens` in
 * `@deepseek-ai/dsh-client-ui-chat`: one decimal below 100 units, whole numbers
 * from there up, and no unit above millions (a billion tokens reads as 1200M).
 */
export function formatTokenCount(value: number): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value >= 1_000_000) return scaled(value / 1_000_000) + 'M'
  if (value >= 1_000) return scaled(value / 1_000) + 'K'
  return String(value)
}

/**
 * Render the context segment: the Web meter's share of the window, followed by
 * the estimated figure and the window it divides by, then the compaction
 * trigger point. Keeping the percentage identical across surfaces matters more
 * than folding the trigger into it, and stating the trigger avoids implying it
 * sits at 100%.
 */
function formatContext(metrics: SessionMetrics): string {
  if (metrics.contextPercent === undefined) return 'ctx —'
  const estimate = metrics.contextEstimateTokens
  const window = metrics.contextWindowTokens
  const compact = metrics.contextCompactPercent
  if (estimate === undefined || window === undefined) return 'ctx ' + String(metrics.contextPercent) + '%'
  const trigger = compact === undefined ? '' : ' · compact at ' + String(compact) + '%'
  return 'ctx ' + String(metrics.contextPercent) + '%  (~'
    + formatTokenCount(estimate) + ' / ' + formatTokenCount(window) + trigger + ')'
}

/** One composition bucket as `/context` prints it. */
export interface ContextBreakdownRow {
  /** Which bucket this row is, for the palette's per-bucket color role. */
  readonly bucket: 'system' | 'tools' | 'messages'
  /** Legend label, matching the Web meter's panel rows. */
  readonly label: string
  /** Bucket glyph: the same cell the bar paints, so the row marks its own segment. */
  readonly glyph: string
  /** Heuristic tokens in this bucket. */
  readonly tokens: number
  /** Tenths of a percent of the heuristic total; the three always sum to 1000. */
  readonly tenths: number
}

/** Heuristic composition plus the shares and bar derived from it. */
export interface ContextComposition {
  /** One row per bucket, in bar-segment order. */
  readonly rows: readonly ContextBreakdownRow[]
  /**
   * Track representing the whole model window, with the used share split by the
   * printed composition shares; empty for an empty surface.
   */
  readonly bar: string
}

/** Cells in the bar: enough resolution for the composition, short enough for a narrow terminal. */
const BAR_CELLS = 40

/**
 * The one glyph every bucket is drawn with.
 *
 * Colour, not shape, separates the buckets — the same choice the Web panel makes
 * with its three tinted bar segments. Distinct block glyphs would also work, but
 * a legend row then has to repeat its own shape, and no choice of three block
 * characters reads clearly at one-cell widths on every font.
 */
const BAR_FILL = '█'

/** Glyph for the part of the window the context has not used. */
const BAR_TRACK_GLYPH = '░'

/**
 * Render the bar the Web panel draws under its headline.
 *
 * The bar spans the MODEL WINDOW, not the composition: only the used share is
 * filled, so its length states the same occupancy percentage the headline
 * prints. Filling the whole width would say "100% used" while the headline said
 * 25%, which is exactly how the Web panel is laid out and how this was misread.
 *
 * Inside the used share the cells are the printed composition shares
 * apportioned, so a segment never contradicts its number. Every bucket with a
 * share is guaranteed a cell, exactly as the Web panel keeps `min-width: 2px` on
 * its segments: at forty cells a 0.2% tool schema rounds to nothing, and its
 * legend row would then point at a colour the bar never shows. That cell comes
 * out of the largest bucket — the only one that can spare it without
 * disappearing — so the used share never grows past the headline percentage.
 * @param shares - tenths-of-a-percent shares from {@link contextCompositionShares}.
 * @param percent - whole-percent occupancy of the window.
 * @param tint - colours one bucket's cells; identity for a plain report.
 * @returns one row of block characters; empty for an empty composition.
 */
export function contextCompositionBar(
  shares: ContextCompositionShares,
  percent: number,
  tint: (bucket: 'system' | 'tools' | 'messages') => (text: string) => string = () => (text: string) => text,
): string {
  const weights = [shares.system, shares.tools, shares.messages]
  if (weights.every(weight => weight <= 0)) return ''
  const occupancy = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  if (occupancy <= 0) return tint('system')(BAR_TRACK_GLYPH.repeat(BAR_CELLS))
  // A window that any usage at all was measured in must not render as an empty
  // track: one cell is the smallest thing this display can say.
  const filled = Math.min(BAR_CELLS, Math.max(1, Math.round(occupancy / 100 * BAR_CELLS)))
  const cells = apportion(weights, filled)
  // Give every non-empty bucket at least one cell, taking it from the largest
  // bucket that still has a spare, so no legend row points at a missing colour.
  const present = weights
    .map((weight, index) => ({ index, weight }))
    .filter(entry => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
  for (const entry of present) {
    if ((cells[entry.index] ?? 0) > 0) continue
    const donor = present.find(candidate => (cells[candidate.index] ?? 0) > 1)
    if (donor === undefined) break
    cells[donor.index] = (cells[donor.index] ?? 0) - 1
    cells[entry.index] = 1
  }
  const segments = cells
    .map((width, index) => (width > 0 ? tint(COMPOSITION_BUCKETS[index] ?? 'system')(BAR_FILL.repeat(width)) : ''))
    .join('')
  // The minimum-cell rule conserves the total, and apportionment itself can only
  // lose a cell to rounding, so the track is measured from the real total.
  const used = Math.max(filled, cells.reduce((sum, value) => sum + value, 0))
  return segments + tint('system')(BAR_TRACK_GLYPH.repeat(Math.max(0, BAR_CELLS - used)))
}

/** Bucket keys, in bar-segment order, matching the palette's per-bucket color role. */
const COMPOSITION_BUCKETS = ['system', 'tools', 'messages'] as const

/** Legend labels, in bar-segment order, worded as the Web meter's panel words them. */
const COMPOSITION_LABELS = ['system prompt', 'tool definitions', 'messages'] as const

/**
 * Turn one composition reading into the legend rows and bar `/context` prints.
 * @param breakdown - heuristic composition from {@link contextBreakdown}.
 * @param percent - whole-percent occupancy of the window, which sets the bar's length.
 * @param tint - colours one bucket's cells; identity for a plain report.
 * @returns the legend rows and the bar; empty rows for an empty surface.
 */
export function contextComposition(
  breakdown: ContextBreakdown,
  percent: number,
  tint?: (bucket: 'system' | 'tools' | 'messages') => (text: string) => string,
): ContextComposition {
  const values = [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens]
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total === 0) return { rows: [], bar: '' }
  const shares = contextCompositionShares(breakdown)
  const percents = [shares.system, shares.tools, shares.messages]
  return {
    rows: values.map((tokens, index) => ({
      bucket: COMPOSITION_BUCKETS[index] ?? 'system',
      label: COMPOSITION_LABELS[index] ?? '',
      glyph: BAR_FILL,
      tokens,
      tenths: percents[index] ?? 0,
    })),
    bar: contextCompositionBar(shares, percent, tint),
  }
}

/**
 * Format the session's decode throughput the way the Web stats pill does:
 * whole numbers from ten up, one decimal below.
 * @param tps - tokens per second.
 * @returns the number without its unit.
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Render the compact metrics segment for the status bar. */
export function formatSessionMetrics(metrics: SessionMetrics): string {
  return [
    String(metrics.turns) + ' turns',
    String(metrics.steps) + ' steps',
    metrics.tokensPerSecond === undefined ? '— tok/s' : formatTokensPerSecond(metrics.tokensPerSecond) + ' tok/s',
    formatTokenCount(metrics.totalTokens) + ' tok',
    'cache ' + (metrics.cacheHit === undefined ? '—' : metrics.cacheHit + '%'),
    formatContext(metrics),
  ].join('  ·  ')
}