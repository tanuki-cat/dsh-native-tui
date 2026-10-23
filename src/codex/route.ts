/**
 * Ensure the `openai-codex` route exists in the `llm-pi-ai` settings.
 *
 * The route is the only profile-level state the feature needs: a `models: []`
 * list selects pi-ai's native catalogue, and an absent `apiKeyEnv` lets the
 * adapter authenticate from the OAuth record. Setup never overwrites a route a
 * user already configured.
 *
 * @module dsh-native-tui/codex/route
 */

import { findSettingsNamespace, writeSettingsOps, type SettingsAccess } from '../runtime/settings-write.js'
import { CODEX_PROVIDER, type ModelCatalog } from './types.js'

/** What setup found or changed. */
export type RouteState =
  | { readonly kind: 'present'; readonly apiKeyEnv?: string }
  | { readonly kind: 'added' }
  | { readonly kind: 'blocked'; readonly apiKeyEnv: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'unverified'; readonly added: boolean; readonly reason: string }

/** One route read without writing anything. */
export interface RouteProfile {
  readonly kind: 'unavailable' | 'missing' | 'present' | 'blocked'
  readonly apiKeyEnv?: string
  readonly value?: Record<string, unknown>
}

/** Bounds for the post-write registration probe. */
export interface RouteOptions {
  readonly wait?: (ms: number) => Promise<void>
  readonly attempts?: number
  readonly intervalMs?: number
}

/** Whether a value is a non-array object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the route without writing.
 * @param settings - Host settings slice, when mounted.
 * @returns the route profile.
 */
export function routeProfile(settings: SettingsAccess | undefined): RouteProfile {
  if (settings === undefined) return { kind: 'unavailable' }
  const descriptor = findSettingsNamespace(settings, 'llm-pi-ai')
  if (descriptor === undefined) return { kind: 'unavailable' }
  const providers = objectOf(descriptor.value.providers)
  const raw = providers?.[CODEX_PROVIDER]
  if (raw === undefined) return { kind: 'missing' }
  const route = objectOf(raw)
  const apiKeyEnv = typeof route?.apiKeyEnv === 'string' && route.apiKeyEnv !== '' ? route.apiKeyEnv : undefined
  return {
    kind: apiKeyEnv === undefined ? 'present' : 'blocked',
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(route === undefined ? {} : { value: route }),
  }
}

/** Whether the adapter has registered the route. */
function registered(llm: ModelCatalog | undefined): boolean {
  if (llm === undefined) return false
  try {
    return llm.listProviders().some(provider => provider.id === CODEX_PROVIDER)
  }
  catch {
    return false
  }
}

/**
 * Wait for the adapter to register the route.
 * @param llm - LLM catalogue, when mounted.
 * @param options - probe bounds; defaults to 200ms × 25 (5s).
 * @returns true once the route is registered.
 */
export async function waitForProvider(llm: ModelCatalog | undefined, options: RouteOptions = {}): Promise<boolean> {
  if (llm === undefined) return false
  const attempts = Math.max(1, options.attempts ?? 25)
  const intervalMs = options.intervalMs ?? 200
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (registered(llm)) return true
    if (attempt < attempts - 1) await wait(intervalMs)
  }
  return false
}

/**
 * Ensure the Codex route exists and is registered.
 *
 * A route that already exists is never rewritten, even when it carries an
 * `apiKeyEnv` reference; that case is reported as `blocked` so the caller can
 * ask before changing the user's configuration.
 * @param settings - Host settings slice.
 * @param llm - LLM catalogue.
 * @param options - registration probe bounds.
 * @returns what setup found or changed.
 */
export async function ensureCodexRoute(
  settings: SettingsAccess | undefined,
  llm: ModelCatalog | undefined,
  options: RouteOptions = {},
): Promise<RouteState> {
  const profile = routeProfile(settings)
  if (profile.kind === 'unavailable') return { kind: 'unavailable', reason: 'the llm-pi-ai settings namespace is unavailable' }
  if (profile.kind === 'blocked') return { kind: 'blocked', apiKeyEnv: profile.apiKeyEnv ?? '' }
  if (profile.kind === 'present') return { kind: 'present' }

  const access = settings as SettingsAccess
  const descriptor = findSettingsNamespace(access, 'llm-pi-ai')
  if (descriptor === undefined) return { kind: 'unavailable', reason: 'the llm-pi-ai settings namespace disappeared' }
  const fresh = await writeSettingsOps(access, 'llm-pi-ai', [
    { op: 'set', path: ['providers', CODEX_PROVIDER], value: { models: [] } },
  ], descriptor.revision)
  if (fresh === undefined) return { kind: 'unavailable', reason: 'the llm-pi-ai settings namespace disappeared while saving' }

  return await waitForProvider(llm, options)
    ? { kind: 'added' }
    : { kind: 'unverified', added: true, reason: 'the provider did not register within the probe window' }
}

/**
 * Remove the credential reference that makes the adapter bypass OAuth.
 * @param settings - Host settings slice.
 * @returns true when the write was applied.
 */
export async function removeApiKeyEnvReference(settings: SettingsAccess): Promise<boolean> {
  const descriptor = findSettingsNamespace(settings, 'llm-pi-ai')
  if (descriptor === undefined) return false
  return await writeSettingsOps(settings, 'llm-pi-ai', [
    { op: 'unset', path: ['providers', CODEX_PROVIDER, 'apiKeyEnv'] },
  ], descriptor.revision) !== undefined
}

/**
 * Remove the route this feature added.
 * @param settings - Host settings slice.
 * @returns true when the write was applied.
 */
export async function removeCodexRoute(settings: SettingsAccess): Promise<boolean> {
  const descriptor = findSettingsNamespace(settings, 'llm-pi-ai')
  if (descriptor === undefined) return false
  return await writeSettingsOps(settings, 'llm-pi-ai', [
    { op: 'unset', path: ['providers', CODEX_PROVIDER] },
  ], descriptor.revision) !== undefined
}

/**
 * Count the models the routed adapter lists, keeping the failure reason.
 * @param llm - LLM catalogue.
 * @returns the count, or the catalogue error.
 */
export async function countCodexModels(llm: ModelCatalog | undefined): Promise<{ readonly count: number; readonly error?: string }> {
  if (llm === undefined) return { count: 0, error: 'the LLM catalogue service is unavailable' }
  try {
    return { count: (await llm.listModels(CODEX_PROVIDER)).length }
  }
  catch (error) {
    return { count: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
