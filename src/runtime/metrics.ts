import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

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
  readonly cacheHitPercent?: number
  readonly contextPercent?: number
}

function usageNumber(usage: Record<string, unknown>, key: string): number {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Fold provider usage records and official stats into status-bar metrics.
 * Turns/steps come from session-stats when present; the event fallback keeps
 * the line useful in compositions without that projection.
 * @param events - complete durable Session event log.
 * @param stats - optional whole-session sessionStats projection.
 * @param contextWindow - selected model context capacity, when known.
 * @returns cumulative token/cache figures and latest context occupancy.
 */
export function collectSessionMetrics(
  events: readonly SessionEvent[],
  stats?: SessionStats,
  contextWindow?: number,
): SessionMetrics {
  let turns = stats?.turns ?? 0
  let steps = stats?.steps ?? 0
  let totalTokens = 0
  let cacheReadTokens = 0
  let promptTokens = 0
  let latestPromptTokens = 0
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
    if (event.type !== 'assistant/message') continue
    const raw = event.data.usage
    if (raw === null || typeof raw !== 'object') continue
    const usage = raw as unknown as Record<string, unknown>
    const input = usageNumber(usage, 'inputTokens')
    const output = usageNumber(usage, 'outputTokens')
    const cacheRead = usageNumber(usage, 'cacheReadTokens')
    const cacheWrite = usageNumber(usage, 'cacheWriteTokens')
    const total = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0
      ? usage.totalTokens
      : input + output + cacheRead + cacheWrite
    totalTokens += total
    cacheReadTokens += cacheRead
    const prompt = input + cacheRead + cacheWrite
    promptTokens += prompt
    latestPromptTokens = prompt
  }
  const tokensPerSecond = stats !== undefined && stats.decodeMs > 0 && stats.decodeTokens > 0
    ? stats.decodeTokens / (stats.decodeMs / 1000)
    : undefined
  return {
    turns,
    steps,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    totalTokens,
    ...(promptTokens > 0 ? { cacheHitPercent: Math.round(cacheReadTokens / promptTokens * 100) } : {}),
    ...(contextWindow !== undefined && contextWindow > 0
      ? { contextPercent: Math.round(Math.min(1, latestPromptTokens / contextWindow) * 100) }
      : {}),
  }
}

/** Compact token count used in the status bar. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace(/.0$/u, '') + 'B'
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/.0$/u, '') + 'M'
  if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/.0$/u, '') + 'K'
  return String(value)
}

/** Render the compact metrics segment for the status bar. */
export function formatSessionMetrics(metrics: SessionMetrics): string {
  return [
    String(metrics.turns) + ' turns',
    String(metrics.steps) + ' steps',
    metrics.tokensPerSecond === undefined ? '— tok/s' : Math.round(metrics.tokensPerSecond) + ' tok/s',
    formatTokenCount(metrics.totalTokens) + ' tok',
    'cache ' + (metrics.cacheHitPercent === undefined ? '—' : String(metrics.cacheHitPercent) + '%'),
    'ctx ' + (metrics.contextPercent === undefined ? '—' : String(metrics.contextPercent) + '%'),
  ].join('  ·  ')
}
