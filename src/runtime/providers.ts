/** Supported hand-declared pi-ai wire protocols. */
export const PROVIDER_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

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
    }],
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
