export const COMPACTION_THRESHOLD_RATIO = 0.8
export const COMPACTION_HEADROOM_TOKENS = 65_536

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export interface CompactionBudget {
  readonly window: number
  readonly reserved: number
}

export interface CompactionPolicy {
  readonly auto: boolean
  readonly ratio: number
  readonly hasModelThreshold: boolean
  readonly headroom: number
  readonly retainRatio?: number
  readonly retainTokens?: number
  readonly summaryMax: number
  readonly summaryRoute?: ModelRoute
}

type PolicyRow = Record<string, unknown> & ModelRoute
export type ThresholdFields = Readonly<Partial<Record<'thresholdRatio' | 'headroomTokens' | 'maxTokens', number>>>

export interface ThresholdPlan {
  readonly percent: number
  readonly tokens: number
  readonly policy: CompactionPolicy
  readonly fields: ThresholdFields
}

export function sameRoute(left: ModelRoute | undefined, right: ModelRoute | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

export function configRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function modelPolicies(config: Record<string, unknown>): PolicyRow[] {
  const list = config.modelPolicies
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('Compaction modelPolicies must be an array.')
  const seen = new Set<string>()
  return list.map(value => {
    const row = configRecord(value)
    if (row === undefined || typeof row.provider !== 'string' || row.provider === ''
      || typeof row.model !== 'string' || row.model === '') throw new Error('Compaction policy needs a provider and model.')
    const key = JSON.stringify([row.provider, row.model])
    if (seen.has(key)) throw new Error('Duplicate compaction policy for ' + row.provider + '/' + row.model + '.')
    seen.add(key)
    return row as PolicyRow
  })
}

function numberField(config: Record<string, unknown> | undefined, key: string, valid: (n: number) => boolean): number | undefined {
  const value = config?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !valid(value)) throw new Error('Invalid compaction setting: ' + key + '.')
  return value
}

const ratioValue = (n: number): boolean => n > 0 && n <= 1
const tokenValue = (n: number): boolean => Number.isSafeInteger(n) && n >= 0
export const positiveTokens = (n: number): boolean => tokenValue(n) && n > 0

function retention(config: Record<string, unknown> | undefined): Pick<CompactionPolicy, 'retainTokens' | 'retainRatio'> | undefined {
  const ratio = numberField(config, 'retainRatio', ratioValue)
  const tokens = numberField(config, 'retainTokens', tokenValue)
  if (ratio !== undefined && tokens !== undefined) throw new Error('Compaction retention has both retainRatio and retainTokens.')
  return ratio !== undefined ? { retainRatio: ratio } : tokens !== undefined ? { retainTokens: tokens } : undefined
}

/** Resolve the same exact-target fields from a raw preset or an active Host config. */
export function resolveCompactionPolicy(config: Record<string, unknown>, route: ModelRoute): CompactionPolicy {
  const row = modelPolicies(config).find(entry => sameRoute(entry, route))
  const modelRatio = numberField(row, 'thresholdRatio', ratioValue)
  const headroom = numberField(row, 'headroomTokens', tokenValue)
    ?? numberField(config, 'headroomTokens', tokenValue) ?? COMPACTION_HEADROOM_TOKENS
  const summaryMax = numberField(row, 'maxTokens', positiveTokens) ?? numberField(config, 'maxTokens', positiveTokens) ?? headroom
  const summaryProvider = row?.summarizationProvider ?? config.summarizationProvider
  const summaryModel = row?.summarizationModel ?? config.summarizationModel
  if (config.auto !== undefined && typeof config.auto !== 'boolean') throw new Error('Invalid automatic compaction setting.')
  if (!positiveTokens(summaryMax)) throw new Error('Zero compaction headroom requires a positive summary output limit.')
  return {
    auto: config.auto !== false,
    ratio: modelRatio ?? numberField(config, 'thresholdRatio', ratioValue) ?? COMPACTION_THRESHOLD_RATIO,
    hasModelThreshold: modelRatio !== undefined,
    headroom,
    ...(retention(row) ?? retention(config) ?? { retainRatio: 0.16 }),
    summaryMax,
    ...(typeof summaryProvider === 'string' && summaryProvider !== '' && typeof summaryModel === 'string' && summaryModel !== ''
      ? { summaryRoute: { provider: summaryProvider, model: summaryModel } } : {}),
  }
}

export function thresholdTokens(window: number, reserved: number, ratio: number, headroom: number): number {
  return Math.floor(Math.min(window * ratio, window - reserved - headroom))
}

export function effectiveThreshold(policy: CompactionPolicy, { window, reserved }: CompactionBudget): number | undefined {
  if (!positiveTokens(window) || !tokenValue(reserved) || policy.retainRatio !== undefined && policy.retainRatio >= policy.ratio) return undefined
  const tokens = thresholdTokens(window, reserved, policy.ratio, policy.headroom)
  const kept = policy.retainTokens ?? Math.floor((window - reserved) * (policy.retainRatio ?? 0))
  return tokens > kept ? tokens : undefined
}

export function targetThreshold(percent: number, budget: CompactionBudget): number {
  return Math.floor(budget.window * (percent / 100))
}

export function planThreshold(
  percent: number, budget: CompactionBudget, baseline: CompactionPolicy, summaryMax = baseline.summaryMax,
): ThresholdPlan | undefined {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return undefined
  const tokens = targetThreshold(percent, budget)
  const limit = budget.window - budget.reserved - tokens
  if (limit < 0 || !positiveTokens(summaryMax)) return undefined
  const headroom = Math.min(baseline.headroom, limit)
  const policy = { ...baseline, ratio: percent / 100, hasModelThreshold: true, headroom, summaryMax }
  if (effectiveThreshold(policy, budget) !== tokens) return undefined
  return {
    percent, tokens, policy,
    fields: {
      thresholdRatio: policy.ratio,
      ...(headroom === baseline.headroom ? {} : { headroomTokens: headroom }),
      ...(summaryMax === baseline.summaryMax ? {} : { maxTokens: summaryMax }),
    },
  }
}

export function highestThreshold(requested: number, budget: CompactionBudget, baseline: CompactionPolicy): ThresholdPlan | undefined {
  for (let percent = requested - 1; percent >= 1; percent -= 1) {
    const candidate = planThreshold(percent, budget, baseline)
    if (candidate !== undefined) return candidate
  }
  return undefined
}

/** Accept text input percentages without floating-point or locale-dependent parsing. */
export function parseThresholdPercent(text: string): number | undefined {
  return /^(?:[1-9][0-9]?|100)%?$/u.test(text) ? Number(text.replace(/%$/u, '')) : undefined
}
