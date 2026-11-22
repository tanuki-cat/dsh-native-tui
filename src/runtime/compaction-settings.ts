import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  configRecord, modelPolicies, planThreshold, resolveCompactionPolicy, sameRoute,
  type CompactionBudget, type CompactionPolicy, type ModelRoute, type ThresholdFields, type ThresholdPlan,
} from './compaction-policy.js'

interface PresetEntry {
  readonly options: { readonly name: string; readonly config?: unknown }
}

interface ConfigEditor {
  readonly documentPath: string
  entries(): readonly PresetEntry[]
  edit(entry: PresetEntry, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

interface PresetRegistry {
  composedPreset(ctx: Context): string | undefined
  serviceFor(agent: Agent, service: 'compaction'): unknown
  resolve(id: string): Promise<{ readonly id: string; readonly broken?: unknown }>
  readDocument(id: string): Promise<{ readonly agentPreset: string; readonly content: string }>
}

export interface CompactionSettings {
  readonly preset: string
  readonly editor: ConfigEditor
  readonly registry: PresetRegistry
}

const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const COMPACTION_PLUGIN = '@deepseek-ai/dsh-compaction-basic'
const thresholdFields = ['thresholdRatio', 'headroomTokens', 'maxTokens'] as const

/** Locate the single enabled Basic compactor inside the declared preset. */
function compactorRow(preset: Record<string, unknown>): Record<string, unknown> {
  const matches: Record<string, unknown>[] = []
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const item of entries) {
      const row = configRecord(item)
      if (row === undefined || row.disabled === true) continue
      if (row.name === COMPACTION_PLUGIN) matches.push(row)
      if (row.group === true) visit(row.config)
    }
  }
  visit(preset.plugins)
  const [row] = matches
  if (row === undefined || matches.length !== 1) throw new Error('Expected one compaction-basic entry in the active preset.')
  return row
}

function compactorConfig(row: Record<string, unknown>): Record<string, unknown> {
  if (row.config === undefined) return {}
  const config = configRecord(row.config)
  if (config === undefined) throw new Error('The preset compaction configuration is not an object.')
  return config
}

function presetEntry({ editor, preset }: CompactionSettings): PresetEntry {
  const entries = editor.entries().filter(entry => entry.options.name === PRESET_PLUGIN && configRecord(entry.options.config)?.id === preset)
  const [entry] = entries
  if (entry === undefined || entries.length !== 1) throw new Error('Preset ' + preset + ' has no unique editable profile declaration.')
  return entry
}

function mountedBasicConfig(service: unknown): Record<string, unknown> | undefined {
  const config = configRecord(configRecord(service)?.config)
  // The Basic engine exposes its resolved config, with defaults and a policy list.
  return config !== undefined && typeof config.auto === 'boolean' && typeof config.thresholdRatio === 'number'
    && typeof config.headroomTokens === 'number' && Array.isArray(config.modelPolicies) ? config : undefined
}

export function readCompactionSettings(host: Context, agent: Agent): CompactionSettings {
  const editor = host.get('configEditor') as ConfigEditor | undefined
  const registry = host.get('agentPresets') as PresetRegistry | undefined
  const preset = registry?.composedPreset(agent.ctx)
  if (editor === undefined || registry === undefined || preset === undefined) {
    throw new Error('Compaction settings need an editable Host profile and an active Agent preset.')
  }
  if (mountedBasicConfig(registry.serviceFor(agent, 'compaction')) === undefined) {
    throw new Error('The active preset has no supported compaction policy service.')
  }
  return { editor, registry, preset }
}

/** The active Agent may still use the older revision of a saved preset. */
export function mountedCompactionPolicy(host: Context, agent: Agent, route: ModelRoute): CompactionPolicy | undefined {
  const registry = host.get('agentPresets') as PresetRegistry | undefined
  const engine = registry?.serviceFor?.(agent, 'compaction') ?? host.get('compaction')
  const config = mountedBasicConfig(engine)
  if (config === undefined) return undefined
  try { return resolveCompactionPolicy(config, route) }
  catch { return undefined }
}

export function declaredCompactionPolicy(settings: CompactionSettings, route: ModelRoute): CompactionPolicy {
  const row = compactorRow(configRecord(presetEntry(settings).options.config) ?? {})
  return resolveCompactionPolicy(compactorConfig(row), route)
}

function routeFields(config: Record<string, unknown>, route: ModelRoute, keys: readonly (typeof thresholdFields)[number][] = thresholdFields): ThresholdFields {
  const row = modelPolicies(config).find(policy => sameRoute(policy, route))
  return Object.fromEntries(keys.filter(key => Object.hasOwn(row ?? {}, key)).map(key => [key, row?.[key]]))
}

interface PolicyChange {
  readonly keys: readonly (typeof thresholdFields)[number][]
  readonly oldFields: ThresholdFields
  readonly savedFields: ThresholdFields
  readonly hadPolicy: boolean
  readonly hadList: boolean
  readonly hadConfig: boolean
}

/** Update only the exact route, pinning an otherwise implicit summary cap when headroom shrinks. */
function applyPlan(row: Record<string, unknown>, route: ModelRoute, plan: ThresholdPlan): PolicyChange | undefined {
  const config = compactorConfig(row)
  const list = modelPolicies(config)
  const existing = list.find(policy => sameRoute(policy, route))
  const oldFields = routeFields(config, route)
  const fields = {
    ...plan.fields,
    ...(plan.fields.headroomTokens !== undefined && config.maxTokens === undefined && existing?.maxTokens === undefined
      ? { maxTokens: plan.policy.summaryMax } : {}),
  }
  const keys = thresholdFields.filter(key => fields[key] !== undefined && (!Object.hasOwn(oldFields, key) || oldFields[key] !== fields[key]))
  if (keys.length === 0) return undefined
  const change = {
    keys, oldFields: routeFields(config, route, keys), savedFields: Object.fromEntries(keys.map(key => [key, fields[key]])),
    hadPolicy: existing !== undefined, hadList: Object.hasOwn(config, 'modelPolicies'), hadConfig: Object.hasOwn(row, 'config'),
  }
  const updated = { ...existing, provider: route.provider, model: route.model, ...fields }
  row.config = { ...config, modelPolicies: existing === undefined ? [...list, updated] : list.map(policy => policy === existing ? updated : policy) }
  return change
}

function restorePlan(preset: Record<string, unknown>, route: ModelRoute, change: PolicyChange): Record<string, unknown> {
  const row = compactorRow(preset)
  const config = compactorConfig(row)
  const list = modelPolicies(config)
  const existing = list.find(policy => sameRoute(policy, route))
  if (existing === undefined || !isDeepStrictEqual(routeFields(config, route, change.keys), change.savedFields)) {
    throw new Error('The model policy changed after saving. Restore its threshold fields in the profile patch.')
  }
  const restored = { ...existing }
  for (const key of change.keys) delete restored[key]
  Object.assign(restored, change.oldFields)
  const keep = change.hadPolicy || Object.keys(restored).length > 2
  const policies = list.flatMap(policy => policy === existing ? keep ? [restored] : [] : [policy])
  const nextConfig = { ...config }
  if (policies.length > 0 || change.hadList) nextConfig.modelPolicies = policies
  else delete nextConfig.modelPolicies
  if (Object.keys(nextConfig).length > 0 || change.hadConfig) row.config = nextConfig
  else delete row.config
  return preset
}

async function verifyPreset(settings: CompactionSettings): Promise<{ readonly agentPreset: string; readonly content: string }> {
  const status = await settings.registry.resolve(settings.preset)
  if (status.broken !== undefined) throw new Error('Preset ' + settings.preset + ' could not mount: ' + String(status.broken))
  const document = await settings.registry.readDocument(settings.preset)
  if (document.agentPreset !== settings.preset) throw new Error('Host returned a different preset declaration.')
  return document
}

export async function saveCompactionThreshold(
  settings: CompactionSettings, route: ModelRoute, budget: CompactionBudget, baseline: CompactionPolicy,
  plan: ThresholdPlan, canSave: () => boolean,
): Promise<boolean> {
  const { editor, registry, preset } = settings
  const before = await verifyPreset(settings)
  const entry = presetEntry(settings)
  let change: PolicyChange | undefined
  const edit = (current: Record<string, unknown>): Record<string, unknown> => {
    if (!canSave()) throw new Error('Session or request budget changed. Reopen the threshold preview.')
    const proposed = structuredClone(current)
    const row = compactorRow(proposed)
    const latest = resolveCompactionPolicy(compactorConfig(row), route)
    const verified = planThreshold(plan.percent, budget, latest, plan.policy.summaryMax)
    if (!isDeepStrictEqual(baseline, latest) || !isDeepStrictEqual(verified, plan)) {
      throw new Error('Compaction policy changed. Reopen the threshold preview.')
    }
    change = applyPlan(row, route, plan)
    return proposed
  }

  edit(configRecord(entry.options.config) ?? {})
  if (change === undefined) return false
  await editor.edit(entry, edit)
  const saved: PolicyChange | undefined = change
  if (saved === undefined) return false
  try {
    const document = await verifyPreset(settings)
    const row = compactorRow(configRecord(presetEntry(settings).options.config) ?? {})
    const config = compactorConfig(row)
    if (document.content === before.content || !isDeepStrictEqual(routeFields(config, route, saved.keys), saved.savedFields)
      || !isDeepStrictEqual(resolveCompactionPolicy(config, route), plan.policy)) {
      throw new Error('The saved policy was not found in the updated preset.')
    }
    return true
  } catch (error) {
    try {
      await editor.edit(presetEntry(settings), current => restorePlan(structuredClone(current), route, saved))
      const status = await registry.resolve(preset)
      if (status.broken !== undefined) throw new Error(String(status.broken))
    } catch (rollback) {
      throw new Error('Preset verification failed: ' + String(error) + '. Could not restore ' + route.provider + '/' + route.model
        + ' in ' + editor.documentPath + ': ' + String(rollback))
    }
    throw new Error('Preset verification failed and the previous policy was restored: ' + String(error))
  }
}
