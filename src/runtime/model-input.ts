/**
 * Declared input modalities for pi-ai provider models.
 *
 * A model's `input` lives either in an explicit `models` entry or, for a
 * catalog route, in `modelOverrides`. This module locates that declaration,
 * describes it, and builds the settings edit a guided editor persists.
 *
 * @module dsh-native-tui/runtime/model-input
 */

import { PROVIDER_INPUT_MODALITIES, type ProviderInputModality } from './providers.js'

/** Where one model's input declaration is stored in its provider profile. */
export type ModelInputStorage = 'models' | 'override'

/** One editable input declaration plus where it lives. */
export interface ModelInputTarget {
  readonly route: string
  readonly model: string
  readonly storage: ModelInputStorage
  /** Explicit declaration; absent or empty means "inherit the route default". */
  readonly declared?: readonly ProviderInputModality[]
  /** Merged provider profile the model was found in. */
  readonly profile: Record<string, unknown>
  /** Index in `profile.models` for {@link storage} `models`. */
  readonly index?: number
  /** True when the profile patch already owns this `models` array, so a leaf path applies. */
  readonly userOwnsModelIndex: boolean
}

/** Why one model's input declaration cannot be edited here. */
export type ModelInputRefusal = 'provider-missing' | 'model-not-listed' | 'invalid-input'

/** Result of locating one model's declaration in the merged provider profiles. */
export type ModelInputLocation =
  | { readonly ok: true; readonly target: ModelInputTarget }
  | { readonly ok: false; readonly reason: ModelInputRefusal }

/** One `settings.mutate` operation that persists a declaration. */
export type ModelInputOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one explicit declaration before it reaches pi-ai. */
export function validateModelInput(modalities: readonly string[]): ProviderInputModality[] {
  if (modalities.length === 0) throw new Error('input must contain text and/or image')
  if (modalities.some(modality => !PROVIDER_INPUT_MODALITIES.includes(modality as ProviderInputModality)))
    throw new Error('input must contain only text and image')
  if (new Set(modalities).size !== modalities.length)
    throw new Error('input must not repeat a modality')
  return PROVIDER_INPUT_MODALITIES.filter(modality => modalities.includes(modality))
}

/**
 * Read one stored declaration.
 * @param value - the entry's `input` field.
 * @returns the modalities in canonical order, `undefined` when absent or
 *   empty (both mean "inherit"), or `'invalid'` for a value pi-ai refuses.
 */
function readInput(value: unknown): readonly ProviderInputModality[] | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return 'invalid'
  if (value.length === 0) return undefined
  if (value.some(modality => !PROVIDER_INPUT_MODALITIES.includes(modality as ProviderInputModality)))
    return 'invalid'
  const declared = new Set(value)
  return PROVIDER_INPUT_MODALITIES.filter(modality => declared.has(modality))
}

/**
 * Locate the input declaration of one model in a merged `providers` dictionary.
 * @param providers - the `llm-pi-ai` `providers` value.
 * @param route - provider route key.
 * @param model - model id.
 * @param user - the profile patch's own section, used to decide whether a
 *   `models` array can be edited by index without restating it.
 * @returns the editable target, or why it is unavailable.
 */
export function locateModelInput(
  providers: unknown,
  route: string,
  model: string,
  user?: unknown,
): ModelInputLocation {
  if (!isRecord(providers)) return { ok: false, reason: 'provider-missing' }
  const profile = providers[route]
  if (!isRecord(profile)) return { ok: false, reason: 'provider-missing' }

  const models = Array.isArray(profile.models) ? profile.models : []
  if (models.length > 0) {
    const index = models.findIndex(entry => isRecord(entry) && entry.id === model)
    const entry = index === -1 ? undefined : models[index]
    if (!isRecord(entry)) return { ok: false, reason: 'model-not-listed' }
    const declared = readInput(entry.input)
    if (declared === 'invalid') return { ok: false, reason: 'invalid-input' }
    const userProfile = isRecord(user) && isRecord(user.providers) ? user.providers[route] : undefined
    const userModels = isRecord(userProfile) && Array.isArray(userProfile.models) ? userProfile.models : undefined
    const userEntry = userModels?.[index]
    return {
      ok: true,
      target: {
        route,
        model,
        storage: 'models',
        declared,
        profile,
        index,
        userOwnsModelIndex: isRecord(userEntry) && userEntry.id === model,
      },
    }
  }

  const overrides = isRecord(profile.modelOverrides) ? profile.modelOverrides : {}
  const override = overrides[model]
  if (override !== undefined && !isRecord(override)) return { ok: false, reason: 'invalid-input' }
  const declared = readInput(isRecord(override) ? override.input : undefined)
  if (declared === 'invalid') return { ok: false, reason: 'invalid-input' }
  return {
    ok: true,
    target: {
      route,
      model,
      storage: 'override',
      declared,
      profile,
      userOwnsModelIndex: false,
    },
  }
}

/** One-line description of a declaration for menus and notices. */
export function modelInputSummary(declared?: readonly ProviderInputModality[]): string {
  if (declared === undefined || declared.length === 0) return 'not declared (inherits route default)'
  if (declared.length === 1 && declared[0] === 'text') return 'text only'
  if (declared.length === 2 && declared[0] === 'text' && declared[1] === 'image') return 'text + image'
  return declared.join(' + ')
}

/**
 * Build the settings edit that persists one declaration.
 *
 * A profile patch that already owns the `models` array gets a leaf edit, so
 * the write touches one entry. An array inherited from a bundle layer cannot
 * be addressed by index in the patch, so that case restates the merged array.
 * Catalog routes always get a `modelOverrides` leaf, which merges with the
 * installed catalog and leaves other models alone.
 * @param target - located declaration target.
 * @param modalities - declaration to persist, or `undefined` to remove it and
 *   inherit the route default.
 * @returns one `set` or `unset` op for `settings.mutate`.
 */
export function modelInputWrite(
  target: ModelInputTarget,
  modalities?: readonly ProviderInputModality[],
): ModelInputOp {
  const value = modalities === undefined ? undefined : validateModelInput(modalities)
  if (target.storage === 'override') {
    const path = ['providers', target.route, 'modelOverrides', target.model, 'input']
    return value === undefined ? { op: 'unset', path } : { op: 'set', path, value }
  }
  if (target.index === undefined) throw new Error('model input target has no model index')
  if (target.userOwnsModelIndex) {
    const path = ['providers', target.route, 'models', String(target.index), 'input']
    return value === undefined ? { op: 'unset', path } : { op: 'set', path, value }
  }
  const models = Array.isArray(target.profile.models) ? target.profile.models : []
  return {
    op: 'set',
    path: ['providers', target.route, 'models'],
    value: models.map((entry, index) => {
      if (index !== target.index) return entry
      const next = isRecord(entry) ? { ...entry } : {}
      if (value === undefined) delete next.input
      else next.input = value
      return next
    }),
  }
}
