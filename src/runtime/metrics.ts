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
  /** Event-log decode totals when the sessionStats projection is not mounted. */
  let fallbackDecodeMs = 0
  let fallbackDecodeTokens = 0
  for (const event of events) {
    if (stats === undefined && event.type === 'turn/start') turns += 1
    if (stats === undefined && event.type === 'step/end') steps += 1
    if ((event.type as string) === 'compaction/summary') {
      const shadowed = (event.data as { readonly shadowedTokenCount?: unknown }).shadowedTokenCount
      if (typeof shadowed === 'number' && Number.isFinite(shadowed) && shadowed > 0) {
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
