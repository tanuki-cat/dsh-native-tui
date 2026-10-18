/** Supported hand-declared pi-ai wire protocols. */
export const PROVIDER_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** Input modalities a hand-declared provider model may claim. */
export const PROVIDER_INPUT_MODALITIES = ['text', 'image'] as const

/** One input modality accepted by a hand-declared model. */
export type ProviderInputModality = typeof PROVIDER_INPUT_MODALITIES[number]

/** Thinking levels a pi-ai profile may map to wire values. */
export const PROVIDER_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One selectable reasoning level in a hand-declared model. */
export type ProviderReasoningLevel = typeof PROVIDER_REASONING_LEVELS[number]

/**
 * Default level-to-wire map written for a newly merged discovery model that
 * declares none, so a plain endpoint listing still offers /reasoning.
 */
export const DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string | null>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
}

/** One supported hand-declared wire protocol. */
export type ProviderProtocol = typeof PROVIDER_PROTOCOLS[number]

/** Inputs collected by the guided custom-provider flow. */
export interface CustomProviderInput {
  readonly route: string
  readonly api: ProviderProtocol
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly modelId: string
  readonly modelName?: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input?: readonly ProviderInputModality[]
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>
}

/** Validate a provider route key. */
export function isValidProviderRoute(route: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(route)
}

/** Validate an environment-variable credential reference. */
export function isValidEnvName(name: string): boolean {
  // Uppercase-only is deliberate: it keeps API keys (mixed case, punctuation,
  // or token prefixes) from being stored as an environment-variable name.
  return name.length <= 64 && /^[A-Z_][A-Z0-9_]*$/u.test(name)
}

/**
 * Normalize an HTTP(S) endpoint.
 * @param value - URL entered by the operator.
 * @returns URL without a trailing slash.
 * @throws when the URL is not HTTP(S).
 */
export function normalizeBaseURL(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('baseURL must be a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('baseURL must use http or https')
  return url.toString().replace(/\/$/u, '')
}

/** Build one hand-declared provider profile from guided inputs. */
export function buildCustomProvider(input: CustomProviderInput): Record<string, unknown> {
  if (!isValidProviderRoute(input.route)) throw new Error('route must be lowercase letters, digits, and hyphens, starting with a letter')
  if (!PROVIDER_PROTOCOLS.includes(input.api)) throw new Error('unsupported protocol')
  if (!isValidEnvName(input.apiKeyEnv)) throw new Error('apiKeyEnv must be an uppercase environment variable name, not the API key')
  if (input.modelId.trim() === '') throw new Error('model id must not be empty')
  if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0) throw new Error('contextWindow must be a positive integer')
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) throw new Error('maxTokens must be a positive integer')
  if (input.input !== undefined
    && (input.input.length === 0
      || input.input.some(modality => !PROVIDER_INPUT_MODALITIES.includes(modality))
      || new Set(input.input).size !== input.input.length)) {
    throw new Error('input must contain unique text/image modalities')
  }
  if (input.reasoningEfforts !== undefined) validateReasoningEfforts(input.reasoningEfforts)
  const name = input.modelName?.trim() === '' || input.modelName === undefined ? input.modelId.trim() : input.modelName.trim()
  return {
    api: input.api,
    baseURL: normalizeBaseURL(input.baseURL),
    apiKeyEnv: input.apiKeyEnv,
    models: [{
      id: input.modelId.trim(),
      name,
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      ...(input.input === undefined ? {} : { input: [...input.input] }),
      ...(input.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...input.reasoningEfforts } }),
    }],
  }
}

/** Validate one explicit reasoning-effort map before it reaches pi-ai. */
export function validateReasoningEfforts(efforts: Readonly<Record<string, string | null>>): void {
  const levels = Object.keys(efforts)
  if (levels.length === 0) throw new Error('reasoningEfforts must not be empty')
  for (const level of levels) {
    if (!PROVIDER_REASONING_LEVELS.includes(level as ProviderReasoningLevel)) {
      throw new Error('reasoningEfforts has unknown level "' + level + '"')
    }
    const value = efforts[level]
    if (level !== 'off' && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error('reasoningEfforts.' + level + ' must be a non-empty wire value')
    }
    if (value !== null && typeof value !== 'string') {
      throw new Error('reasoningEfforts.' + level + ' must be a string or null')
    }
  }
  if (!levels.some(level => level !== 'off')) {
    throw new Error('reasoningEfforts must offer a level beyond off')
  }
}

/** Parse a comma-separated list into pi-ai's level-to-wire-value map. */
export function parseReasoningLevels(raw: string): Record<string, string | null> | undefined {
  const levels = [...new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))]
  if (levels.length === 0) return undefined
  for (const level of levels) {
    if (!PROVIDER_REASONING_LEVELS.includes(level as ProviderReasoningLevel)) {
      throw new Error('unknown reasoning level "' + level + '"')
    }
  }
  if (!levels.some(level => level !== 'off')) {
    throw new Error('reasoning levels must include at least one level other than off')
  }
  return Object.fromEntries(levels.map(level => [level, level === 'off' ? null : level]))
}

/**
 * Merge one guided model into an existing hand-declared route without
 * discarding models the operator configured earlier. A matching id is
 * replaced; other models keep their order and settings.
 * @param existing - current route profile, if any.
 * @param next - profile built from the current guided selection.
 * @returns the route profile with merged models.
 */
export function mergeProviderModel(existing: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const existingModels = Array.isArray(base.models)
    ? base.models.filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object' && !Array.isArray(model))
    : []
  const nextModels = Array.isArray(next.models)
    ? next.models.filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object' && !Array.isArray(model))
    : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const model of existingModels) {
    if (typeof model.id === 'string') byId.set(model.id, model)
  }
  for (const model of nextModels) {
    if (typeof model.id === 'string') byId.set(model.id, model)
  }
  return { ...base, ...next, models: [...byId.values()] }
}

/** One model returned by endpoint discovery, as used by an existing route. */
export interface DiscoveredProviderModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly inputModalities?: readonly string[]
}

/** Result of refreshing one existing provider route from its model listing. */
export interface MergedDiscoveredModels {
  readonly provider: Record<string, unknown>
  readonly added: number
  readonly updated: number
}

/**
 * Upsert every endpoint-discovered model into an existing route profile.
 * Existing model settings (reasoning maps, custom input) survive a refresh;
 * discovered capacities and names replace stale metadata. A newly added model
 * that declares no map gets {@link DEFAULT_REASONING_EFFORTS}.
 * @param existing - current route profile.
 * @param discovered - models returned by discovery.
 * @returns the updated provider plus added and updated counts.
 */
export function mergeDiscoveredProviderModels(
  existing: unknown,
  discovered: readonly DiscoveredProviderModel[],
): MergedDiscoveredModels {
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const models = Array.isArray(base.models)
    ? base.models.filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object' && !Array.isArray(model))
    : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const model of models) {
    if (typeof model.id === 'string') byId.set(model.id, model)
  }
  let added = 0
  let updated = 0
  for (const candidate of discovered) {
    if (candidate.id.trim() === '') continue
    const current = byId.get(candidate.id)
    const input = candidate.inputModalities?.filter(modality => modality === 'text' || modality === 'image')
    const next: Record<string, unknown> = {
      ...(current ?? {}),
      id: candidate.id,
      name: candidate.name ?? (typeof current?.name === 'string' ? current.name : candidate.id),
      contextWindow: typeof candidate.contextWindow === 'number' && candidate.contextWindow > 0
        ? candidate.contextWindow
        : (typeof current?.contextWindow === 'number' ? current.contextWindow : 128000),
      maxTokens: typeof candidate.maxTokens === 'number' && candidate.maxTokens > 0
        ? candidate.maxTokens
        : (typeof current?.maxTokens === 'number' ? current.maxTokens : 16384),
      ...(current?.input === undefined && input !== undefined && input.length > 0 ? { input } : {}),
      ...(current === undefined ? { reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } } : {}),
    }
    if (current === undefined) added += 1
    else updated += 1
    byId.set(candidate.id, next)
  }
  return { provider: { ...base, models: [...byId.values()] }, added, updated }
}

/**
 * Build the route entry for one discovery model the operator did not configure
 * by hand. Used for the extra models /provider add imports next to the selected
 * one. Missing capacities fall back to conservative defaults and the entry
 * always carries {@link DEFAULT_REASONING_EFFORTS}.
 * @param candidate - one model returned by endpoint discovery.
 * @returns a model entry ready to append to a route profile.
 */
export function buildDiscoveredModelEntry(candidate: DiscoveredProviderModel): Record<string, unknown> {
  const input = candidate.inputModalities?.filter(modality => modality === 'text' || modality === 'image')
  return {
    id: candidate.id,
    name: candidate.name ?? candidate.id,
    contextWindow: typeof candidate.contextWindow === 'number' && candidate.contextWindow > 0
      ? candidate.contextWindow
      : 128000,
    maxTokens: typeof candidate.maxTokens === 'number' && candidate.maxTokens > 0
      ? candidate.maxTokens
      : 16384,
    ...(input === undefined || input.length === 0 ? {} : { input }),
    reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS },
  }
}

/** Build a catalog-route profile that only names a credential. */
export function buildCatalogProvider(apiKeyEnv: string): Record<string, unknown> {
  if (!isValidEnvName(apiKeyEnv)) throw new Error('apiKeyEnv must be an uppercase environment variable name, not the API key')
  return { apiKeyEnv }
}

/**
 * Merge one provider profile into the current providers dictionary.
 * @param existing - current settings value, if any.
 * @param route - provider route key.
 * @param provider - profile to store.
 * @returns a new dictionary with the route replaced.
 */
export function mergeProviderProfiles(
  existing: unknown,
  route: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  if (!isValidProviderRoute(route)) throw new Error('invalid provider route')
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  return { ...base, [route]: provider }
}
