import { describe, expect, it, vi } from 'vitest'
import {
  effectiveThreshold, highestThreshold, parseThresholdPercent, planThreshold, resolveCompactionPolicy,
  type CompactionBudget,
} from '../src/runtime/compaction-policy.js'
import { declaredCompactionPolicy, mountedCompactionPolicy, readCompactionSettings, saveCompactionThreshold } from '../src/runtime/compaction-settings.js'
import { ContextModelBudgets, readContextInputs } from '../src/runtime/context-reading.js'
import { createSessionMetricsMemo, type CompactionReading } from '../src/runtime/metrics.js'
import { contextReport } from '../src/ui/commands/context-stats.js'

const qwen = { provider: 'local', model: 'qwen' }
const other = { provider: 'local', model: 'inkling' }
const budget = { window: 147_456, reserved: 32_768 }
const defaults = resolveCompactionPolicy({}, qwen)
const mountedDefaults = { auto: true, thresholdRatio: 0.8, headroomTokens: 65_536, modelPolicies: [] }

describe('per-model compaction budgets', () => {
  it.each(['0', '101', '-1', '90.5', '90% trailing', '1e2', ''])('rejects %j', input => {
    expect(parseThresholdPercent(input)).toBeUndefined()
  })

  it('suggests the highest valid integer with the requested production budget', () => {
    expect(parseThresholdPercent('90%')).toBe(90)
    expect(effectiveThreshold(defaults, budget)).toBe(49_152)
    expect(planThreshold(75, budget, defaults)).toMatchObject({ tokens: 110_592, policy: { headroom: 4_096, summaryMax: 65_536 } })
    expect(planThreshold(90, budget, defaults)).toBeUndefined()
    expect(planThreshold(78, budget, defaults)).toBeUndefined()
    expect(highestThreshold(90, budget, defaults)).toMatchObject({ percent: 77, tokens: 113_541, policy: { headroom: 1_147, summaryMax: 65_536 } })
    expect(planThreshold(85, { ...budget, reserved: 18_000 }, { ...defaults, headroom: 4_096 }))
      .toMatchObject({ tokens: 125_337, policy: { headroom: 4_096 } })
  })

  it('honors floor rounding and rejects budgets at or below retention', () => {
    const small = resolveCompactionPolicy({ maxTokens: 8 }, qwen)
    expect(highestThreshold(90, { window: 101, reserved: 23 }, small)).toMatchObject({ percent: 78, tokens: 78, policy: { headroom: 0, summaryMax: 8 } })
    expect(highestThreshold(90, budget, resolveCompactionPolicy({ retainTokens: 113_541 }, qwen))).toBeUndefined()
    expect(highestThreshold(90, { ...budget, reserved: budget.window }, defaults)).toBeUndefined()
    expect(planThreshold(16, budget, defaults)).toBeUndefined()
    expect(planThreshold(77, budget, defaults, 0)).toBeUndefined()
  })

  it('follows Host summary cap and retention inheritance', () => {
    const model = { ...qwen, headroomTokens: 0, retainTokens: 0 }
    expect(() => resolveCompactionPolicy({ modelPolicies: [model] }, qwen)).toThrow('positive summary output limit')
    expect(resolveCompactionPolicy({ retainRatio: 0.3, maxTokens: 9000, modelPolicies: [model] }, qwen))
      .toMatchObject({ headroom: 0, retainTokens: 0, summaryMax: 9000 })
    expect(resolveCompactionPolicy({ modelPolicies: [{ ...qwen, headroomTokens: 17 }] }, qwen).summaryMax).toBe(17)
    expect(() => resolveCompactionPolicy({ modelPolicies: [model, model] }, qwen)).toThrow('Duplicate')
  })

  it('accepts retainRatio and retainTokens together with the token count taking precedence', () => {
    const policy = resolveCompactionPolicy({ retainRatio: 0.3, retainTokens: 100_000 }, qwen)
    expect(policy).toMatchObject({ retainRatio: 0.3, retainTokens: 100_000 })
    // The window can keep 49_152 trigger tokens and the 100_000-token
    // retention floor exceeds it, so the effective trigger disappears.
    expect(effectiveThreshold(policy, budget)).toBeUndefined()
    // Without the token floor the ratio alone would leave a valid trigger.
    expect(effectiveThreshold({ ...policy, retainTokens: undefined }, budget)).toBe(49_152)
    expect(resolveCompactionPolicy({ modelPolicies: [{ ...qwen, retainRatio: 0.2, retainTokens: 8000 }] }, qwen))
      .toMatchObject({ retainRatio: 0.2, retainTokens: 8000 })
    // A high retainRatio must not veto a lower explicit retainTokens floor.
    const ratioAboveThreshold = resolveCompactionPolicy({ thresholdRatio: 0.5, retainRatio: 0.9, retainTokens: 1000 }, qwen)
    expect(effectiveThreshold(ratioAboveThreshold, budget)).toBe(49_152)
  })
})

function editorHarness(raw: Record<string, unknown> | undefined = undefined) {
  const unrelated = { id: 'tool', name: 'tool', disabled: { __jsExpr: 'process.platform === "win32"' } }
  const compactor = { name: '@deepseek-ai/dsh-compaction-basic', ...(raw === undefined ? {} : { config: raw }) }
  const group = { id: 'compaction', group: true, config: [compactor] }
  const entry: { options: { name: string; config: Record<string, unknown> } } = {
    options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'ptc', plugins: [group, unrelated] } },
  }
  const currentConfig = () => ((entry.options.config.plugins as typeof group[])[0]!.config[0] as { config?: Record<string, unknown> }).config
  let edits = 0
  let brokenAfterSave: (() => void) | undefined
  const edit = vi.fn(async (_entry: unknown, next: (config: Record<string, unknown>) => Record<string, unknown>) => {
    entry.options.config = next(structuredClone(entry.options.config))
    edits += 1
    if (edits === 1) brokenAfterSave?.()
  })
  const editor = { entries: () => [entry], edit, documentPath: '/tmp/tui/cordis.patch.yml' }
  const registry = {
    composedPreset: () => 'ptc', serviceFor: () => ({ config: { ...mountedDefaults, ...raw } }),
    resolve: async () => ({ id: 'ptc', ...(brokenAfterSave !== undefined && edits === 1 ? { broken: 'child failed' } : {}) }),
    readDocument: async () => ({ agentPreset: 'ptc', content: JSON.stringify(entry.options.config) }),
  }
  const services: Record<string, unknown> = { configEditor: editor, agentPresets: registry }
  const host = { get: (key: string) => services[key] }
  const settings = readCompactionSettings(host as never, { ctx: {} } as never)
  const save = async (percent: number, allowsWrite = () => true, modelBudget = budget) => {
    const policy = declaredCompactionPolicy(settings, qwen)
    const selection = { ...qwen, reasoningEffort: 'high' }
    return saveCompactionThreshold(settings, selection, modelBudget, policy, planThreshold(percent, modelBudget, policy)!, allowsWrite)
  }
  return { entry, edit, currentConfig, save, failAfterSave: (change: () => void = () => {}) => { brokenAfterSave = change }, unrelated }
}

describe('Host preset edits', () => {
  it('merges one route, preserves expressions, and pins the old implicit summary cap', async () => {
    const h = editorHarness({ modelPolicies: [{ ...other, thresholdRatio: 0.73 }, { ...qwen, compactionRetries: 3 }] })
    await expect(h.save(77)).resolves.toBe(true)
    expect(h.currentConfig()).toEqual({ modelPolicies: [
      { ...other, thresholdRatio: 0.73 }, { ...qwen, compactionRetries: 3, thresholdRatio: 0.77, headroomTokens: 1147, maxTokens: 65536 },
    ] })
    expect(h.entry.options.config.plugins).toContainEqual(h.unrelated)
    await expect(h.save(77)).resolves.toBe(false)
    expect(h.edit).toHaveBeenCalledTimes(1)
    expect(resolveCompactionPolicy(h.currentConfig()!, other).ratio).toBe(0.73)
    expect(resolveCompactionPolicy(h.currentConfig()!, { ...qwen, provider: 'other' })).toEqual(defaults)
  })

  it('restores a broken new preset even while the old Agent can still read its compactor', async () => {
    const h = editorHarness()
    h.failAfterSave()
    await expect(h.save(77)).rejects.toThrow('previous policy was restored')
    expect(h.currentConfig()).toBeUndefined()
    expect(h.edit).toHaveBeenCalledTimes(2)
  })

  it('persists an explicit positive summary cap when the selected percentage leaves zero headroom', async () => {
    const h = editorHarness()
    await expect(h.save(100, () => true, { ...budget, reserved: 0 })).resolves.toBe(true)
    expect(h.currentConfig()).toEqual({ modelPolicies: [{ ...qwen, thresholdRatio: 1, headroomTokens: 0, maxTokens: 65536 }] })
  })

  it('persists an explicit model baseline even when it equals the inherited ratio', async () => {
    const h = editorHarness()
    await expect(h.save(80, () => true, { window: 1_000_000, reserved: 100_000 })).resolves.toBe(true)
    expect(h.currentConfig()).toEqual({ modelPolicies: [{ ...qwen, thresholdRatio: 0.8 }] })
  })

  it('retains concurrent edits to an untouched field during rollback', async () => {
    const h = editorHarness({ modelPolicies: [{ ...qwen, maxTokens: 5000 }] })
    h.failAfterSave(() => {
      const item = (h.currentConfig()!.modelPolicies as Array<{ maxTokens: number }>)[0]!
      item.maxTokens = 6000
    })
    await expect(h.save(77)).rejects.toThrow('previous policy was restored')
    expect(h.currentConfig()).toEqual({ modelPolicies: [{ ...qwen, maxTokens: 6000 }] })
  })

  it('reports a concurrent change to a written field without replacing it', async () => {
    const h = editorHarness()
    h.failAfterSave(() => { (h.currentConfig()!.modelPolicies as Array<{ headroomTokens: number }>)[0]!.headroomTokens = 500 })
    await expect(h.save(77)).rejects.toThrow('Could not restore local/qwen in /tmp/tui/cordis.patch.yml')
    expect(h.currentConfig()).toMatchObject({ modelPolicies: [{ headroomTokens: 500 }] })
  })

  it('checks command ownership inside the Host edit callback', async () => {
    const h = editorHarness()
    let attempts = 0
    await expect(h.save(77, () => ++attempts === 1)).rejects.toThrow('Session or request budget changed')
    expect(h.currentConfig()).toBeUndefined()
  })
})

describe('active compaction metrics', () => {
  it('does not infer a Basic threshold from an unrelated compactor configuration', () => {
    const registry = { composedPreset: () => 'ptc', serviceFor: () => ({ config: {} }) }
    const host = { get: (key: string) => key === 'agentPresets' ? registry : {} }
    const agent = { ctx: {} }
    expect(mountedCompactionPolicy(host as never, agent as never, qwen)).toBeUndefined()
    expect(() => readCompactionSettings(host as never, agent as never)).toThrow('no supported compaction policy service')
  })

  it('reports a known threshold without usage and refreshes when only the policy changes', () => {
    const fold = createSessionMetricsMemo()
    const events = [] as const
    const input: CompactionReading = { state: 'known', route: 'local/qwen', window: budget.window, tokens: 49152, percent: 100 / 3 }
    const before = fold(events, undefined, budget.window, {}, input)
    expect(before.contextPercent).toBeUndefined()
    expect(contextReport(before, undefined)).toContain('49,152 tokens')
    expect(contextReport(before, undefined)).not.toContain('configured')
    const explicit = fold(events, undefined, budget.window, {}, { ...input, configuredPercent: 80 })
    expect(explicit).not.toBe(before)
    expect(contextReport(explicit, undefined)).toContain('configured 80%')
    const after = fold(events, undefined, budget.window, {}, { ...input, tokens: 113541, percent: 113541 / budget.window * 100, configuredPercent: 77 })
    expect(after).not.toBe(before)
    expect(contextReport(after, undefined)).toContain('113,541 tokens')
    expect(fold(events, undefined, budget.window, {}, { ...after.compaction! })).toBe(after)
    expect(contextReport(fold(events, undefined, budget.window, {}, { state: 'disabled', route: 'local/qwen' }), undefined))
      .toContain('Automatic compaction: disabled')
  })

  it('uses the Host catalogue window for both usage and the check line when they differ', () => {
    const budgets = new ContextModelBudgets()
    budgets.remember(qwen, budget.window, budget.reserved)
    const session = {
      requestHeader: () => ({ config: { ...qwen, maxTokens: budget.reserved } }),
      requestContext: () => ({ ...qwen, contextWindow: 200_000 }),
      snapshotEvents: () => [],
    }
    const services: Record<string, unknown> = {
      agentPresets: { serviceFor: () => ({ config: mountedDefaults }) },
      sessionProjections: { snapshot: () => ({ values: { contextPressure: { projectedTokens: 50_000 } } }) },
    }
    const host = { get: (name: string) => services[name] }
    const input = readContextInputs(host as never, { session } as never, qwen, budgets)
    const metrics = createSessionMetricsMemo()(input.events, input.stats, input.window, input.meter.reading, input.compaction)
    expect(metrics).toMatchObject({
      contextWindowTokens: budget.window, contextPercent: 34,
      compaction: { window: budget.window, tokens: 49_152, percent: 49_152 / budget.window * 100 },
    })
    expect(metrics.compaction).not.toHaveProperty('configuredPercent')
  })

  it('keeps the previous request reservation separate from a pending selection', () => {
    const budgets = new ContextModelBudgets()
    const cache = (route: typeof qwen, model: CompactionBudget) => budgets.remember(route, model.window, model.reserved)
    cache(qwen, budget)
    cache(other, { window: 200000, reserved: 32000 })
    let route = qwen
    const session = { requestHeader: () => ({ config: { ...route, ...(route === qwen ? { maxTokens: 32768 } : {}) } }),
      requestContext: () => ({ ...qwen, contextWindow: budget.window }), snapshotEvents: () => [] }
    const agent = { session }
    const engine = { config: { ...mountedDefaults, modelPolicies: [{ ...qwen, thresholdRatio: 0.77, headroomTokens: 1147 }] } }
    const host = { get: (name: string) => name === 'agentPresets' ? { serviceFor: () => engine } : undefined }
    const pending = readContextInputs(host as never, agent as never, other, budgets)
    expect(pending.compaction).toMatchObject({ route: 'local/qwen', tokens: 113541 })
    expect(pending.compactionBaselinePercent).toBeUndefined()
    route = other
    const switchingBack = readContextInputs(host as never, agent as never, qwen, budgets)
    expect(switchingBack.compaction).toMatchObject({ route: 'local/inkling', tokens: 102464 })
    expect(switchingBack.compactionBaselinePercent).toBe(77)
  })

  it('reads the configured baseline without a usage sample or a known budget', () => {
    const session = { requestHeader: () => undefined, requestContext: () => undefined, snapshotEvents: () => [] }
    const config = { ...mountedDefaults, modelPolicies: [{ ...qwen, thresholdRatio: 0.8 }, { ...other, headroomTokens: 5000 }] }
    const engine = { config }
    const host = { get: (name: string) => name === 'agentPresets' ? { serviceFor: () => engine } : undefined }
    const budgets = new ContextModelBudgets()
    const read = (route: typeof qwen) => readContextInputs(host as never, { session } as never, route, budgets)
    expect(read(qwen)).toMatchObject({ compaction: { state: 'unknown' }, compactionBaselinePercent: 80 })
    expect(read(other).compactionBaselinePercent).toBeUndefined()
    expect(read({ ...qwen, provider: 'other' }).compactionBaselinePercent).toBeUndefined()
    config.auto = false
    expect(read(qwen).compactionBaselinePercent).toBeUndefined()
  })
})
