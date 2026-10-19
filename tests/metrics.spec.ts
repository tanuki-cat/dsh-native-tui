import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  collectSessionMetrics,
  compactionThresholdTokens,
  contextPressure,
  formatCacheHitPercent,
  formatSessionMetrics,
  formatTokenCount,
  formatTokensPerSecond,
  contextWindowTokens,
  projectedContextTokens,
} from '../src/runtime/metrics.js'

/** One provider usage reading, as a settlement or a streamed attempt carries it. */
interface UsageShape {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Provider-reported total, which the fold must not prefer over the buckets. */
  readonly reportedTotal?: number
}

function usageRecord(shape: UsageShape): Record<string, unknown> {
  return {
    inputTokens: shape.input,
    outputTokens: shape.output,
    cacheReadTokens: shape.cacheRead,
    cacheWriteTokens: shape.cacheWrite,
    ...(shape.reportedTotal === undefined ? {} : { totalTokens: shape.reportedTotal }),
  }
}

function usageEvent(input: number, output: number, cacheRead: number, cacheWrite: number, turn = 1, step = 1): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: {
      turn,
      step,
      message: { content: [] },
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    },
  } as unknown as SessionEvent
}

/** One interrupted attempt, whose usage only its stream reports. */
function attemptEvent(shape: UsageShape, turn = 1, step = 1): SessionEvent {
  return {
    type: 'assistant/attempt',
    seq: 1,
    time: 1,
    data: {
      turn,
      step,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: usageRecord(shape) } }],
    },
  } as unknown as SessionEvent
}

describe('session metrics', () => {
  it('folds totals, cache hit, and TPS', () => {
    const events = [
      usageEvent(100, 20, 800, 0, 1, 1),
      usageEvent(50, 30, 450, 0, 1, 2),
    ]
    const metrics = collectSessionMetrics(events, { turns: 2, steps: 3, decodeMs: 2000, decodeTokens: 100 }, 1_000_000)
    expect(metrics).toMatchObject({
      turns: 2,
      steps: 3,
      tokensPerSecond: 50,
      totalTokens: 1450,
      cacheHit: '89',
    })
    expect(formatSessionMetrics(metrics)).toContain('2 turns')
    expect(formatSessionMetrics(metrics)).toContain('50 tok/s')
    expect(formatSessionMetrics(metrics)).toContain('1.5K tok')
    expect(formatSessionMetrics(metrics)).toContain('cache 89%')
    expect(formatTokenCount(478_000_000)).toBe('478M')
  })

  it('derives decode throughput from events without the sessionStats projection', () => {
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 3_000,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stream: [{ type: 'text-chunks', time0: 1_000, index: 0, dt: [], texts: ['done'], lastTime: 2_500 }],
      },
    } as unknown as SessionEvent
    const metrics = collectSessionMetrics([event])
    expect(metrics.tokensPerSecond).toBeCloseTo(50)
  })

  it('formats decode throughput like the Web stats pill', () => {
    expect(formatTokensPerSecond(2.44)).toBe('2.4')
    expect(formatTokensPerSecond(9.96)).toBe('10')
    expect(formatTokensPerSecond(10.4)).toBe('10')
    expect(formatTokensPerSecond(1134.4)).toBe('1134')
    expect(formatTokensPerSecond(0)).toBe('0')
  })

  it('counts an interrupted attempt the way the token meter does', () => {
    // A turn that ended on a streamed attempt is still billed; leaving it out
    // would understate the Web's total and cache share for that session.
    const events = [attemptEvent({ input: 200, output: 50, cacheRead: 700, cacheWrite: 0 }, 3, 1)]
    expect(collectSessionMetrics(events)).toMatchObject({ totalTokens: 950, cacheHit: '78' })
  })

  it('replaces a settled step instead of double counting it', () => {
    const events = [
      attemptEvent({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 2, 1),
      usageEvent(120, 30, 0, 0, 2, 1),
    ]
    expect(collectSessionMetrics(events).totalTokens).toBe(150)
  })

  it('adds a retried attempt once llm/retry-started closes the slot', () => {
    const events = [
      attemptEvent({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 4, 1),
      { type: 'llm/retry-started', seq: 2, time: 2, data: { turn: 4, step: 1 } },
      attemptEvent({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 4, 1),
    ] as unknown as SessionEvent[]
    expect(collectSessionMetrics(events).totalTokens).toBe(220)
  })

  it('sums the four buckets even when the provider reports its own total', () => {
    const event = attemptEvent({ input: 100, output: 20, cacheRead: 800, cacheWrite: 0, reportedTotal: 999_999 }, 5, 1)
    expect(collectSessionMetrics([event]).totalTokens).toBe(920)
  })

  it('falls back to a message stream that carries the usage', () => {
    // A v2 settlement can report usage only inside its compact stream.
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {
        turn: 6,
        step: 1,
        message: { content: [] },
        stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: usageRecord({ input: 10, output: 5, cacheRead: 85, cacheWrite: 0 }) } }],
      },
    } as unknown as SessionEvent
    expect(collectSessionMetrics([event])).toMatchObject({ totalTokens: 100, cacheHit: '89' })
  })

  it('ignores settlements that carry neither usage nor a stream', () => {
    const events = [
      { type: 'assistant/message', seq: 1, time: 1, data: { turn: 7, step: 1, message: { content: [] } } },
      { type: 'assistant/attempt', seq: 2, time: 2, data: { turn: 7, step: 2 } },
    ] as unknown as SessionEvent[]
    expect(collectSessionMetrics(events)).toMatchObject({ totalTokens: 0 })
    expect(collectSessionMetrics(events).cacheHit).toBeUndefined()
  })

  it('renders an em dash for the figures a session has not measured yet', () => {
    const line = formatSessionMetrics(collectSessionMetrics([]))
    expect(line).toContain('— tok/s')
    expect(line).toContain('cache —')
    expect(line).toContain('ctx —')
  })

  it('formats token counts the way the Web pill does', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_450)).toBe('1.5K')
    expect(formatTokenCount(177_157_176)).toBe('177M')
    expect(formatTokenCount(1_200_000_000)).toBe('1200M')
  })

  it('falls back to event turn and step counts without the projection', () => {
    const events = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/end', seq: 2, time: 2, data: {} },
    ] as unknown as SessionEvent[]
    expect(collectSessionMetrics(events)).toMatchObject({ turns: 1, steps: 1, totalTokens: 0 })
  })

  it('reports the Web meter percentage and states the compaction trigger beside it', () => {
    const metrics = collectSessionMetrics([usageEvent(100, 20, 800, 0)], undefined, 1_000_000, { tokens: 400_000 })
    // 400K of a 1M window is 40%; the compactor fires at min(0.8 * 1M, 1M - 65536) = 800K, i.e. 80%.
    expect(metrics).toMatchObject({
      contextPercent: 40,
      contextEstimateTokens: 400_000,
      contextWindowTokens: 1_000_000,
      contextCompactPercent: 80,
    })
    expect(formatSessionMetrics(metrics)).toContain('ctx 40%  (~400K / 1M · compact at 80%)')
  })

  it('narrows the stated trigger when headroom squeezes a small window', () => {
    // 200K window, 32K reserved: the trigger is 101_696 tokens, only 51% of the window.
    const metrics = collectSessionMetrics([usageEvent(1, 1, 1, 0)], undefined, 200_000, { tokens: 50_000, reservedTokens: 32_768 })
    expect(metrics.contextPercent).toBe(25)
    expect(metrics.contextCompactPercent).toBe(51)
    expect(formatSessionMetrics(metrics)).toContain('compact at 51%')
  })

  it('prefers the meter estimate over the last provider prompt', () => {
    // The session log charges 157_578 prompt tokens, but the surface the
    // compactor prices is already 640_000: the report must follow the surface.
    const events = [usageEvent(3_082, 16_384, 154_496, 0)]
    const metrics = collectSessionMetrics(events, undefined, 1_000_000, { tokens: 640_000 })
    expect(metrics.contextPercent).toBe(64)
    expect(metrics.contextEstimateTokens).toBe(640_000)
  })

  it('reports nothing while a mounted meter has no provider sample', () => {
    // A fresh session has a meter and a route capacity but nothing measured
    // yet. The Web meter renders nothing here, so the log's last prompt must
    // not fill the gap with an occupancy nobody sampled.
    const metrics = collectSessionMetrics([usageEvent(100, 20, 800, 0)], undefined, 1_000_000, {})
    expect(metrics).not.toHaveProperty('contextPercent')
    expect(metrics).not.toHaveProperty('contextEstimateTokens')
    expect(formatSessionMetrics(metrics)).toContain('ctx —')
  })

  it('keeps the provider prompt as the fallback estimate', () => {
    // Without the meter argument the log's last prompt is the only estimate.
    const metrics = collectSessionMetrics([usageEvent(100, 20, 800, 0)], undefined, 1_000_000)
    // 900 prompt tokens out of a 1M window rounds to 0%.
    expect(metrics.contextEstimateTokens).toBe(900)
    expect(metrics.contextPercent).toBe(0)
  })

  it('reduces the fallback estimate after a compaction summary', () => {
    // The log path prices the last prompt minus what a summary shadowed: 900
    // sampled tokens less the 600 the compaction replaced.
    const events = [
      usageEvent(100, 20, 800, 0),
      { type: 'compaction/summary', seq: 2, time: 2, data: { shadowedTokenCount: 600, shadowedSeqs: [1] } },
    ] as unknown as SessionEvent[]
    const metrics = collectSessionMetrics(events, undefined, 1_000)
    expect(metrics.contextEstimateTokens).toBe(300)
    expect(metrics.contextPercent).toBe(30)
  })

  it('reduces the fallback estimate after pruning events in the sample', () => {
    // 900 sampled prompt tokens less two pruned tool results that were already
    // part of that sample (seq 5): 200 + 100 pruned tokens.
    const usage = { ...usageEvent(100, 20, 800, 0), seq: 5 } as SessionEvent
    const events = [
      usage,
      { type: 'compaction/prune', seq: 6, time: 6, data: { shadowedTokenCount: 200, shadowedSeqs: [2] } },
      { type: 'compaction/prune', seq: 7, time: 7, data: { shadowedTokenCount: 100, shadowedSeqs: [3] } },
    ] as unknown as SessionEvent[]
    const metrics = collectSessionMetrics(events, undefined, 1_000)
    expect(metrics.contextEstimateTokens).toBe(600)
    expect(metrics.contextPercent).toBe(60)
  })

  it('does not subtract a prune that happened after the latest provider sample', () => {
    // The 100-token tool result was created after the seq-1 sample, so it was
    // never part of latestPromptTokens; subtracting it would understate context.
    const events = [
      usageEvent(100, 20, 800, 0),
      { type: 'compaction/prune', seq: 2, time: 2, data: { shadowedTokenCount: 100, shadowedSeqs: [2] } },
    ] as unknown as SessionEvent[]
    const metrics = collectSessionMetrics(events, undefined, 1_000)
    expect(metrics.contextEstimateTokens).toBe(900)
    expect(metrics.contextPercent).toBe(90)
  })

  it('omits context figures without a window', () => {
    expect(collectSessionMetrics([usageEvent(1, 1, 1, 0)])).not.toHaveProperty('contextPercent')
  })
})

describe('cache-hit share', () => {
  it('never rounds a partial hit up to 100', () => {
    expect(formatCacheHitPercent(176_480_640, 176_789_534)).toBe('99.8')
    expect(formatCacheHitPercent(999_999, 1_000_000)).toBe('99.9999')
    expect(formatCacheHitPercent(9, 10)).toBe('90')
  })

  it('states a complete hit, an empty one, and no input honestly', () => {
    expect(formatCacheHitPercent(1_000, 1_000)).toBe('100')
    expect(formatCacheHitPercent(0, 1_000)).toBe('0')
    expect(formatCacheHitPercent(0, 0)).toBeUndefined()
  })
})

describe('projected context occupancy', () => {
  it('adds the surface movement since the usage sample', () => {
    // The provider sampled 429_078 tokens when the surface held 600_000; it has
    // since grown to 641_605, so the next request pays the difference too.
    expect(projectedContextTokens({ pressureTokens: 429_078, surfaceTokens: 641_605, sampledSurfaceTokens: 600_000 }))
      .toBe(470_683)
  })

  it('holds the sample when the surface is unchanged', () => {
    expect(projectedContextTokens({ pressureTokens: 429_078, surfaceTokens: 600_000, sampledSurfaceTokens: 600_000 }))
      .toBe(429_078)
  })

  it('shrinks after a compaction replacement', () => {
    expect(projectedContextTokens({ pressureTokens: 725_224, surfaceTokens: 200_000, sampledSurfaceTokens: 700_000 }))
      .toBe(225_224)
  })

  it('reports the bare sample before the surface is priced', () => {
    expect(projectedContextTokens({ pressureTokens: 1_234 })).toBe(1_234)
  })

  it('has nothing to report without a usage sample', () => {
    expect(projectedContextTokens(undefined)).toBeUndefined()
    expect(projectedContextTokens({ surfaceTokens: 10 })).toBeUndefined()
  })

  it('reads the capacity recorded on the routed request', () => {
    // The Web meter divides by this value, not by the catalog's declared one.
    expect(contextWindowTokens({ contextWindow: 1_000_000 })).toBe(1_000_000)
    expect(contextWindowTokens({})).toBeUndefined()
    expect(contextWindowTokens(undefined)).toBeUndefined()
    expect(contextWindowTokens({ contextWindow: 0 })).toBeUndefined()
  })
})

describe('compaction threshold', () => {
  it('uses 80% of a large window', () => {
    expect(compactionThresholdTokens(1_000_000)).toBe(800_000)
    expect(compactionThresholdTokens(1_000_000, 16_384)).toBe(800_000)
  })

  it('yields to the fixed headroom on a small window', () => {
    // 200K - 32K reserved - 64K headroom leaves less than 80% of the window.
    expect(compactionThresholdTokens(200_000, 32_768)).toBe(101_696)
    expect(compactionThresholdTokens(128_000, 32_768)).toBe(29_696)
  })

  it('never reports a non-positive budget', () => {
    expect(compactionThresholdTokens(0)).toBe(0)
    expect(compactionThresholdTokens(-1)).toBe(0)
    // A reserve that leaves no pressure budget is a config error the compactor
    // rejects; report the nominal ratio instead of a 1-token threshold.
    expect(compactionThresholdTokens(10_000, 90_000)).toBe(8_000)
  })

  it('clamps the displayed share at 100%', () => {
    expect(contextPressure(1_000_000, 0, 1_600_000)).toEqual({
      estimateTokens: 1_600_000,
      thresholdTokens: 800_000,
      percent: 100,
      compactPercent: 80,
    })
    expect(contextPressure(0, 0, 1)).toBeUndefined()
  })
})
