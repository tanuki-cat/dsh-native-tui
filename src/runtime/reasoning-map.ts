/**
 * Reasoning-effort maps for pi-ai provider models.
 *
 * A map's key is the level Harness offers in `/reasoning`; its value is the
 * spelling the gateway actually receives. The map lives either in an explicit
 * `models` entry or, for a catalog route, in `modelOverrides`. This module
 * finds that location, stages guided edits, and builds the settings path op
 * that persists them.
 *
 * @module dsh-native-tui/runtime/reasoning-map
 */

import {
  DEFAULT_REASONING_EFFORTS,
  PROVIDER_REASONING_LEVELS,
  type ProviderReasoningLevel,
} from './providers.js'

/** One level-to-wire map, in the shape `llm-pi-ai` stores it. */
export type ReasoningEfforts = Record<string, string | null>

/** Where a model's map is stored in its provider profile. */
export type ReasoningMapStorage = 'models' | 'override'

/** One editable map plus where it lives. */
export interface ReasoningMapTarget {
  readonly route: string
  readonly model: string
  readonly storage: ReasoningMapStorage
  /** Current map; empty when the model declares none. */
  readonly efforts: ReasoningEfforts
  /** True when the model explicitly declares `reasoningEfforts: false`. */
  readonly disabled: boolean
  /** Merged provider profile the model was found in. */
  readonly profile: Record<string, unknown>
  /** Index in `profile.models` for {@link storage} `models`. */
  readonly index?: number
  /** True when the profile patch already owns this `models` array, so a leaf path applies. */
  readonly userOwnsModelIndex: boolean
}

/** Why a current model has no editable reasoning map. */
export type ReasoningMapRefusal = 'provider-missing' | 'model-not-listed' | 'invalid-map'

/** Result of locating one model's map in the merged provider profiles. */
export type ReasoningMapLocation =
  | { readonly ok: true; readonly target: ReasoningMapTarget }
  | { readonly ok: false; readonly reason: ReasoningMapRefusal }

/** One settings path edit that persists a map. */
export interface ReasoningMapWrite {
  readonly path: readonly string[]
  readonly value: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one stored map, normalizing an omitted `off` value to `null`. */
function readEfforts(raw: unknown): { efforts: ReasoningEfforts; disabled: boolean } | undefined {
  if (raw === undefined || raw === null) return { efforts: {}, disabled: false }
  if (raw === false) return { efforts: {}, disabled: true }
  if (!isRecord(raw)) return undefined
  const efforts: ReasoningEfforts = {}
  for (const level of PROVIDER_REASONING_LEVELS) {
    if (!Object.hasOwn(raw, level)) continue
    const value = raw[level]
    if (value === null) {
      efforts[level] = null
      continue
    }
    if (typeof value !== 'string') return undefined
    if (value.trim() === '') {
      if (level === 'off') {
        efforts[level] = null
        continue
      }
      return undefined
    }
    efforts[level] = value
  }
  if (Object.keys(raw).some(key => !PROVIDER_REASONING_LEVELS.includes(key as ProviderReasoningLevel)))
    return undefined
  return { efforts, disabled: false }
}

/** Return a map in level order so menus and persisted JSON stay stable. */
function orderedEfforts(efforts: ReasoningEfforts): ReasoningEfforts {
  const ordered: ReasoningEfforts = {}
  for (const level of PROVIDER_REASONING_LEVELS) {
    if (!Object.hasOwn(efforts, level)) continue
    ordered[level] = efforts[level] ?? null
  }
  return ordered
}

/**
 * Locate the map of one model in a merged `providers` dictionary.
 * @param providers - the `llm-pi-ai` `providers` value.
 * @param route - current provider route.
 * @param model - current model id.
 * @param user - the profile patch's own section, used to decide whether a
 *   `models` array can be edited by index without restating it.
 * @returns the editable target, or why it is unavailable.
 */
export function locateReasoningMap(
  providers: unknown,
  route: string,
  model: string,
  user?: unknown,
): ReasoningMapLocation {
  if (!isRecord(providers)) return { ok: false, reason: 'provider-missing' }
  const profile = providers[route]
  if (!isRecord(profile)) return { ok: false, reason: 'provider-missing' }

  const models = Array.isArray(profile.models) ? profile.models : undefined
  if (models !== undefined) {
    const index = models.findIndex(entry => isRecord(entry) && entry.id === model)
    const entry = index === -1 ? undefined : models[index]
    if (!isRecord(entry)) return { ok: false, reason: 'model-not-listed' }
    const parsed = readEfforts(entry.reasoningEfforts)
    if (parsed === undefined) return { ok: false, reason: 'invalid-map' }
    const userProfile = isRecord(user) && isRecord(user.providers) ? user.providers[route] : undefined
    const userModels = isRecord(userProfile) && Array.isArray(userProfile.models) ? userProfile.models : undefined
    const userEntry = userModels?.[index]
    return {
      ok: true,
      target: {
        route,
        model,
        storage: 'models',
        efforts: parsed.efforts,
        disabled: parsed.disabled,
        profile,
        index,
        userOwnsModelIndex: isRecord(userEntry) && userEntry.id === model,
      },
    }
  }

  const overrides = isRecord(profile.modelOverrides) ? profile.modelOverrides : undefined
  const override = overrides?.[model]
  if (override !== undefined && !isRecord(override)) return { ok: false, reason: 'invalid-map' }
  const parsed = readEfforts(isRecord(override) ? override.reasoningEfforts : undefined)
  if (parsed === undefined) return { ok: false, reason: 'invalid-map' }
  return {
    ok: true,
    target: {
      route,
      model,
      storage: 'override',
      efforts: parsed.efforts,
      disabled: parsed.disabled,
      profile,
      userOwnsModelIndex: false,
    },
  }
}

/** Render one wire value, using `omit` for the absent field. */
export function reasoningWireLabel(wire: string | null | undefined): string {
  return wire === null || wire === undefined || wire.trim() === '' ? 'omit' : wire
}

/** One-line summary of a map, in level order. */
export function reasoningMapSummary(efforts: ReasoningEfforts): string {
  const levels = PROVIDER_REASONING_LEVELS.filter(level => Object.hasOwn(efforts, level))
  if (levels.length === 0) return 'no levels'
  return levels.map(level => level + ' → ' + reasoningWireLabel(efforts[level])).join(', ')
}

/** Stage one level addition or wire-value change. */
export function withReasoningLevel(
  efforts: ReasoningEfforts,
  level: ProviderReasoningLevel,
  wire: string | null,
): ReasoningEfforts {
  return orderedEfforts({ ...efforts, [level]: wire })
}

/** Stage one level removal. */
export function withoutReasoningLevel(
  efforts: ReasoningEfforts,
  level: ProviderReasoningLevel,
): ReasoningEfforts {
  const next = { ...efforts }
  delete next[level]
  return orderedEfforts(next)
}

/** The same-name default map the guided provider flow writes. */
export function sameNameReasoningEfforts(): ReasoningEfforts {
  return { ...DEFAULT_REASONING_EFFORTS }
}

/**
 * Build the settings edit that persists one map.
 *
 * A profile patch that already owns the `models` array gets a leaf edit, so
 * the write touches one entry. An array inherited from a bundle layer cannot
 * be addressed by index in the patch, so that case restates the merged array.
 * Catalog routes always get a `modelOverrides` leaf, which merges with the
 * installed catalog and leaves other models alone.
 * @param target - located map target.
 * @param efforts - staged map to persist.
 * @returns one `set` op for `settings.mutate`.
 */
export function reasoningMapWrite(target: ReasoningMapTarget, efforts: ReasoningEfforts): ReasoningMapWrite {
  const map = orderedEfforts(efforts)
  if (target.storage === 'override') {
    return {
      path: ['providers', target.route, 'modelOverrides', target.model, 'reasoningEfforts'],
      value: map,
    }
  }
  if (target.index === undefined) throw new Error('reasoning map target has no model index')
  if (target.userOwnsModelIndex) {
    return {
      path: ['providers', target.route, 'models', String(target.index), 'reasoningEfforts'],
      value: map,
    }
  }
  const models = Array.isArray(target.profile.models) ? target.profile.models : []
  return {
    path: ['providers', target.route, 'models'],
    value: models.map((entry, index) => index === target.index
      ? { ...(isRecord(entry) ? entry : {}), reasoningEfforts: map }
      : entry),
  }
}
