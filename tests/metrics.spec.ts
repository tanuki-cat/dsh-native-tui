import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { collectSessionMetrics, formatSessionMetrics, formatTokenCount } from '../src/runtime/metrics.js'

function usageEvent(input: number, output: number, cacheRead: number, cacheWrite: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      message: { content: [] },
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    },
  } as unknown as SessionEvent
}

describe('session metrics', () => {
  it('folds totals, cache hit, TPS, and latest context occupancy', () => {
    const events = [
      usageEvent(100, 20, 800, 0),
      usageEvent(50, 30, 450, 0),
    ]
    const metrics = collectSessionMetrics(events, { turns: 2, steps: 3, decodeMs: 2000, decodeTokens: 100 }, 1000)
    expect(metrics).toMatchObject({
      turns: 2,
      steps: 3,
      tokensPerSecond: 50,
      totalTokens: 1450,
      cacheHitPercent: 89,
      contextPercent: 50,
    })
    expect(formatSessionMetrics(metrics)).toContain('2 turns')
    expect(formatSessionMetrics(metrics)).toContain('50 tok/s')
    expect(formatSessionMetrics(metrics)).toContain('1.4K tok')
    expect(formatSessionMetrics(metrics)).toContain('cache 89%')
    expect(formatSessionMetrics(metrics)).toContain('ctx 50%')
    expect(formatTokenCount(478_000_000)).toBe('478M')
  })

  it('falls back to event turn and step counts without the projection', () => {
    const events = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/end', seq: 2, time: 2, data: {} },
    ] as unknown as SessionEvent[]
    expect(collectSessionMetrics(events)).toMatchObject({ turns: 1, steps: 1, totalTokens: 0 })
  })
})
