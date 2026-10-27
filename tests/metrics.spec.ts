import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { visibleWidth as visibleWidthForTest } from '@earendil-works/pi-tui'
import {
  collectSessionMetrics,
  compactionThresholdTokens,
  contextBreakdown,
  contextComposition,
  contextCompositionBar,
  contextCompositionShares,
  contextPressure,
  createSessionMetricsMemo,
  formatCacheHitPercent,
  formatSharePercent,
  formatSessionMetrics,
  formatTokenCount,
  formatTokensPerSecond,
  contextWindowTokens,
  projectedContextTokens,
  rebaseComposition,
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

  it('memoizes the fold while its inputs are unchanged', () => {
    const memo = createSessionMetricsMemo()
    const events = [usageEvent(100, 20, 800, 0)]
    const first = memo(events, undefined, 1_000_000, { tokens: 400_000 })
    expect(memo(events, undefined, 1_000_000, { tokens: 400_000 })).toBe(first)
  })

  it('misses when any folded input changes', () => {
    const events = [usageEvent(100, 20, 800, 0)]
    const base = { stats: undefined, window: 1_000_000, meter: { tokens: 400_000 } }
    /** Warm a fresh memo with the baseline, then report whether the variant missed. */
    const misses = (run: (memo: ReturnType<typeof createSessionMetricsMemo>) => unknown): boolean => {
      const memo = createSessionMetricsMemo()
      const first = memo(events, base.stats, base.window, base.meter)
      return run(memo) !== first
    }
    // A new log snapshot, a new projection value, a new window, and a moved
    // meter reading must each miss. Every case warms its own memo, so one miss
    // cannot explain the next assertion.
    expect(misses(memo => memo([...events], base.stats, base.window, base.meter))).toBe(true)
    expect(misses(memo => memo(events, { turns: 1, steps: 1, decodeMs: 1_000, decodeTokens: 50 }, base.window, base.meter))).toBe(true)
    expect(misses(memo => memo(events, base.stats, 200_000, base.meter))).toBe(true)
    expect(misses(memo => memo(events, base.stats, base.window, { tokens: 400_001 }))).toBe(true)
    expect(misses(memo => memo(events, base.stats, base.window, { tokens: 400_000, reservedTokens: 8_192 }))).toBe(true)
    expect(misses(memo => memo(events, base.stats, base.window, undefined))).toBe(true)
  })

  it('hits when the projection hands out an equal state object', () => {
    // The Host may return a fresh object per call; keying on its identity would
    // defeat the memo, so the counters the fold reads are the key instead.
    const memo = createSessionMetricsMemo()
    const events = [usageEvent(100, 20, 800, 0)]
    const stats = { turns: 1, steps: 1, decodeMs: 1_000, decodeTokens: 50 }
    const first = memo(events, stats, 1_000_000, { tokens: 400_000 })
    expect(memo(events, { ...stats }, 1_000_000, { tokens: 400_000 })).toBe(first)
  })

  it('misses when a projection counter moves but the object is reused', () => {
    // Callers may mutate their state in place; the counters, not the reference,
    // decide whether the log has to be folded again.
    const memo = createSessionMetricsMemo()
    const events = [usageEvent(100, 20, 800, 0)]
    const stats = { turns: 1, steps: 1, decodeMs: 1_000, decodeTokens: 50 }
    const first = memo(events, stats, 1_000_000, { tokens: 400_000 })
    stats.decodeTokens = 51
    expect(memo(events, stats, 1_000_000, { tokens: 400_000 })).not.toBe(first)
  })

  it('folds again once the log grew even though the array was reused in place', () => {
    // The Host hands out a frozen snapshot per log length, but a caller may
    // append to its own array; a memo keyed on identity alone would then go
    // stale, so the length is part of the key.
    const memo = createSessionMetricsMemo()
    const events: SessionEvent[] = [usageEvent(100, 20, 0, 0)]
    const first = memo(events)
    events.push(usageEvent(100, 20, 0, 0, 1, 2))
    expect(memo(events)).not.toBe(first)
    expect(memo(events).totalTokens).toBe(240)
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

describe('context composition', () => {
  it('reads the counts from the projection state\'s nested field', () => {
    // The unit publishes its counts under `breakdown`; only its client view
    // flattens them, and `stateOf` hands out the raw state.
    expect(contextBreakdown({ breakdown: { systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 } }))
      .toEqual({ systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 })
  })

  it('narrows unusable figures to zero', () => {
    // Absent figures read as zero so the legend never prints NaN, and a
    // negative price (which the fold should never produce) is clamped.
    expect(contextBreakdown({ breakdown: { systemTokens: -5, toolsTokens: 'x', messageTokens: undefined } }))
      .toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
    // An initial state has no counts yet; that is an empty surface, not silence.
    expect(contextBreakdown({})).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('reports an unmounted projection instead of an empty composition', () => {
    // An unmounted unit and an empty surface are different silences: the first
    // means "ask nothing", the second means "there is nothing yet".
    expect(contextBreakdown(undefined)).toBeUndefined()
    expect(contextBreakdown(null as never)).toBeUndefined()
  })

  it('apportions whole tenths of a percent that total 1000', () => {
    // Rounding each bucket on its own would print 33.3/33.3/33.3 here.
    expect(contextCompositionShares({ systemTokens: 1, toolsTokens: 1, messageTokens: 1 }))
      .toEqual({ system: 334, tools: 333, messages: 333 })
    expect(contextCompositionShares({ systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 }))
      .toEqual({ system: 816, tools: 10, messages: 174 })
  })

  it('keeps a bucket too small for a whole percent distinct from zero', () => {
    // The Web panel prints this as ~628 next to a bar segment; a "0%" label
    // would claim the segment means nothing.
    const shares = contextCompositionShares({ systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 })
    expect(formatSharePercent(shares.tools)).toBe('1.0%')
    expect(formatSharePercent(4)).toBe('0.4%')
    expect(formatSharePercent(1000)).toBe('100.0%')
  })

  it('leaves an empty composition at zero without dividing by it', () => {
    expect(contextCompositionShares({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }))
      .toEqual({ system: 0, tools: 0, messages: 0 })
    expect(contextComposition({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }, 25))
      .toEqual({ rows: [], bar: '' })
  })

  it('fills only the occupied share of the window, never the whole bar', () => {
    // The bug this pins: a fully painted bar beside "Context used: 25%" reads as
    // 100% occupancy. The track spans the window, so the fill length is the
    // headline percentage.
    const bar = contextCompositionBar({ system: 800, tools: 100, messages: 100 }, 25)
    expect(visibleWidthForTest(bar)).toBe(40)
    const filled = [...bar].filter(cell => cell !== '░').length
    expect(filled).toBe(10)
    expect(bar.endsWith('░'.repeat(30))).toBe(true)
  })

  it('sizes each segment inside the filled share from its printed share', () => {
    // The buckets share one glyph and are told apart by colour, exactly as the
    // Web panel does, so the tint is what exposes each run's width here.
    const tint = (bucket: 'system' | 'tools' | 'messages') => (text: string) => '[' + bucket + ':' + text + ']'
    const bar = contextCompositionBar({ system: 500, tools: 250, messages: 250 }, 25, tint)
    // 50/25/25 of the 10 filled cells is 5/2.5/2.5, so the runs are 5/3/2.
    // Every bucket earns more than one cell here, so the minimum rule is moot.
    expect(bar).toBe('[system:' + '█'.repeat(5) + '][tools:' + '█'.repeat(3) + '][messages:' + '█'.repeat(2) + ']'
      + '[system:' + '░'.repeat(30) + ']')
  })

  it('keeps a cell for a bucket too small to earn one on share alone', () => {
    // The Web panel keeps `min-width: 2px` on every segment. Without the same
    // guarantee a 0.2% tool schema rounds to nothing and its legend row points at
    // a colour the bar never draws — the defect this test pins.
    const tint = (bucket: 'system' | 'tools' | 'messages') => (text: string) => '[' + bucket + ':' + text + ']'
    const bar = contextCompositionBar({ system: 816, tools: 10, messages: 174 }, 25, tint)
    expect(bar).toContain('[tools:█]')
    // The cell comes out of the largest bucket, so the used share is unchanged.
    expect([...contextCompositionBar({ system: 816, tools: 10, messages: 174 }, 25)]
      .filter(cell => cell !== '░')).toHaveLength(10)
  })

  it('never renders measured usage as an empty track', () => {
    // Rounding a 0.5% occupancy to zero cells would contradict the headline.
    expect([...contextCompositionBar({ system: 1000, tools: 0, messages: 0 }, 1)].filter(c => c !== '░')).toHaveLength(1)
    expect(contextCompositionBar({ system: 1000, tools: 0, messages: 0 }, 100)).toBe('█'.repeat(40))
  })

  it('renders an empty bar only for an empty composition', () => {
    expect(contextCompositionBar({ system: 0, tools: 0, messages: 0 }, 25)).toBe('')
    // An untouched surface still gets its track, so the bar's length keeps
    // meaning "share of the window".
    expect(contextCompositionBar({ system: 1000, tools: 0, messages: 0 }, 0)).toBe('░'.repeat(40))
  })

  it('labels the rows in bar order and names their bucket', () => {
    const { rows } = contextComposition({ systemTokens: 600, toolsTokens: 300, messageTokens: 100 }, 25)
    // Every row paints the same cell, so the bucket key is what carries colour.
    expect(rows.map(row => [row.bucket, row.label, row.tenths])).toEqual([
      ['system', 'system prompt', 600],
      ['tools', 'tool definitions', 300],
      ['messages', 'messages', 100],
    ])
    expect(new Set(rows.map(row => row.glyph))).toEqual(new Set(['█']))
  })
})

describe('composition rebasing', () => {
  it('makes the buckets sum to the occupancy', () => {
    // The real defect: messages alone exceeded the whole occupancy.
    const raw = { systemTokens: 50_331, toolsTokens: 628, messageTokens: 373_473 }
    const rebased = rebaseComposition(raw, 291_662)
    const sum = (rebased?.systemTokens ?? 0) + (rebased?.toolsTokens ?? 0) + (rebased?.messageTokens ?? 0)
    expect(sum).toBe(291_662)
    expect(rebased?.messageTokens).toBeLessThan(291_662)
    expect(rebased?.rebuilt).toBe('out-of-scale')
  })

  it('keeps the estimator proportions while changing their magnitude', () => {
    expect(rebaseComposition({ systemTokens: 600, toolsTokens: 300, messageTokens: 100 }, 1_000))
      .toEqual({ systemTokens: 600, toolsTokens: 300, messageTokens: 100, rebuilt: 'out-of-scale' })
  })

  it('subtracts the reasoning the request never replays', () => {
    // Without a thinkingSignature the adapter strips those blocks, so their
    // priced tokens come off the bucket and the rest is rescaled onto the
    // occupancy: 500 system against 500-250 dropped messages.
    expect(rebaseComposition({ systemTokens: 500, toolsTokens: 0, messageTokens: 500 }, 1_000, 250))
      .toEqual({ systemTokens: 667, toolsTokens: 0, messageTokens: 333, rebuilt: 'out-of-scale' })
  })

  it('never lets the dropped figure drive a bucket negative', () => {
    // More reasoning priced than the bucket holds means the two sources
    // disagree; clamping keeps the split renderable instead of flipping signs.
    expect(rebaseComposition({ systemTokens: 100, toolsTokens: 0, messageTokens: 50 }, 1_000, 500))
      .toEqual({ systemTokens: 1000, toolsTokens: 0, messageTokens: 0, rebuilt: 'out-of-scale' })
  })

  it('ignores an unusable anchor instead of inventing one', () => {
    const raw = { systemTokens: 1, toolsTokens: 1, messageTokens: 1 }
    expect(rebaseComposition(raw, undefined)).toBeUndefined()
    expect(rebaseComposition(raw, 0)).toBeUndefined()
    expect(rebaseComposition(raw, Number.NaN)).toBeUndefined()
    expect(rebaseComposition({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }, 1_000)).toBeUndefined()
  })

  it('ignores a negative or unusable dropped figure', () => {
    const raw = { systemTokens: 500, toolsTokens: 500, messageTokens: 0 }
    expect(rebaseComposition(raw, 1_000, -5)).toEqual(rebaseComposition(raw, 1_000, 0))
    expect(rebaseComposition(raw, 1_000, Number.NaN)).toEqual(rebaseComposition(raw, 1_000, 0))
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
