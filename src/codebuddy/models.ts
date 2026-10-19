/**
 * Model catalogue: discovery from the gateway plus the shape the adapter and
 * command surface need.
 *
 * GET /v3/config is the same cloud product config the official client reads.
 * It answers 200 without a token, but data.models is only populated when the
 * request carries an account access token — so discovery runs with a
 * credential or not at all.
 *
 * @module dsh-native-tui/codebuddy/models
 */

import { redact } from './errors.js'
import type { CodeBuddyProfile } from './profiles.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from './profiles.js'

/** Input modalities this route can declare; the harness gate reads exactly this list. */
export type InputModality = 'text' | 'image'

/**
 * What every route sends.
 *
 * Frozen: this one array is handed to the harness and shared by every model
 * entry that declares nothing, so an accidental in-place write by one consumer
 * would silently change every other model's declaration.
 */
export const TEXT_ONLY: readonly InputModality[] = Object.freeze(['text'])

/** What a route that accepts images sends. Frozen for the reason given on {@link TEXT_ONLY}. */
export const TEXT_AND_IMAGE: readonly InputModality[] = Object.freeze(['text', 'image'])

/** One catalogue entry in this plugin's own shape. */
export interface CatalogueModel {
  readonly id: string
  readonly name: string
  /** Combined request and response context in tokens. */
  readonly contextWindow: number
  /** Output cap the gateway states, or the conservative default. */
  readonly maxTokens: number
  /** What the gateway states this model accepts; text-only when it states nothing. */
  readonly inputModalities: readonly InputModality[]
  /** Selectable reasoning efforts the gateway reports, when it reports any. */
  readonly reasoningEfforts?: readonly string[]
  /** False when the model cannot turn thinking off. */
  readonly canDisableThinking?: boolean
}

/** Media generators: accepted by the catalogue, rejected by the chat endpoint. */
const NON_CHAT_TAG = /text-to-image|image-to-image|text-to-video|image-to-video/i

/** Raw catalogue entry as the gateway publishes it. All fields are optional guesses. */
interface RawModel {
  id?: unknown
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
  tags?: unknown
  supportsReasoning?: unknown
  /** Measured: a boolean on every entry of both deployments. */
  supportsImages?: unknown
  /** Measured: present on a few entries; true means images are switched off. */
  disabledMultimodal?: unknown
  reasoning?: unknown
}

interface ConfigResponse {
  code?: unknown
  data?: { models?: unknown }
}

/**
 * unverified: /v3/config reports maxInputTokens in tokens. Values that cannot
 * be a token count fall back to the default rather than being rescaled — a
 * wrong context window only affects compaction.
 * @param maxInputTokens - gateway field.
 * @returns the context window to use.
 */
export function contextWindowOf(maxInputTokens: unknown): number {
  const value = Number(maxInputTokens)
  return Number.isFinite(value) && value > 1_000 ? Math.floor(value) : DEFAULT_CONTEXT_WINDOW
}

/**
 * The gateway's own output cap for a model, or the conservative default.
 *
 * A stated value is honoured even when it is below the default — the gateway is
 * the authority on its own models — because a reasoning model pinned to a small
 * cap can spend it all on thinking and return no answer.
 * @param maxOutputTokens - gateway field.
 * @returns the output cap to send.
 */
export function maxOutputTokensOf(maxOutputTokens: unknown): number {
  const value = Number(maxOutputTokens)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Catalogue reasoning object to selectable effort names.
 *
 * Only names the gateway publishes are offered: a level outside this set has no
 * wire spelling the gateway confirmed. An empty result means "nothing known",
 * which leaves the model with no reasoning control rather than a wrong one.
 * @param raw - gateway reasoning object.
 * @returns effort names, or undefined when the gateway states none.
 */
export function reasoningEffortsOf(raw: unknown): { efforts: string[]; canDisableThinking?: boolean } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { supportedEfforts, canDisableThinking } = raw as { supportedEfforts?: unknown; canDisableThinking?: unknown }
  const efforts = Array.isArray(supportedEfforts)
    ? supportedEfforts.filter((level): level is string => typeof level === 'string' && level !== '')
    : []
  if (efforts.length === 0 && canDisableThinking !== false) return undefined
  return {
    efforts,
    ...(canDisableThinking === false ? { canDisableThinking: false } : {}),
  }
}

/**
 * Input modalities one catalogue entry states.
 *
 * Measured 2026-10-19: `supportsImages === true` is trustworthy — every model
 * declaring it read a two-tone test image correctly. `false` is only "the
 * gateway does not promise it": `default` and `glm-5.0` declare false and still
 * read the same image. An untrusted declaration is not a capability, so the
 * default stays text-only and a wrong `false` is corrected through the plugin's
 * per-model override rather than guessed here.
 *
 * `disabledMultimodal` wins over `supportsImages`: when the two disagree, the
 * entry is claiming images are off, and sending bytes would fail the turn.
 * @param raw - gateway entry.
 * @returns the modalities to declare.
 */
export function inputModalitiesOf(raw: Pick<RawModel, 'supportsImages' | 'disabledMultimodal'>): readonly InputModality[] {
  if (raw.disabledMultimodal === true) return TEXT_ONLY
  return raw.supportsImages === true ? TEXT_AND_IMAGE : TEXT_ONLY
}

/**
 * Catalogue entry to one model.
 * @param raw - gateway entry.
 * @returns the model, or undefined for an entry with no usable id.
 */
export function toCatalogueModel(raw: RawModel): CatalogueModel | undefined {
  const { id } = raw
  if (typeof id !== 'string' || id === '') return undefined
  if (Array.isArray(raw.tags) && raw.tags.some(tag => typeof tag === 'string' && NON_CHAT_TAG.test(tag))) return undefined
  const reasoning = raw.supportsReasoning === true ? reasoningEffortsOf(raw.reasoning) : undefined
  return {
    id,
    name: id,
    contextWindow: contextWindowOf(raw.maxInputTokens),
    maxTokens: maxOutputTokensOf(raw.maxOutputTokens),
    inputModalities: inputModalitiesOf(raw),
    ...(reasoning === undefined ? {} : { reasoningEfforts: reasoning.efforts }),
    ...(reasoning?.canDisableThinking === false ? { canDisableThinking: false } : {}),
  }
}

/**
 * Parse a /v3/config body into catalogue models. Never throws.
 * @param text - response body.
 * @returns the models, in endpoint order, deduplicated.
 */
export function parseCatalogue(text: string): CatalogueModel[] {
  let body: ConfigResponse
  try {
    body = JSON.parse(text) as ConfigResponse
  }
  catch {
    return []
  }
  if (body.code !== 0 || !Array.isArray(body.data?.models)) return []
  const models: CatalogueModel[] = []
  const seen = new Set<string>()
  for (const entry of body.data.models) {
    if (entry === null || typeof entry !== 'object') continue
    const model = toCatalogueModel(entry as RawModel)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * The unverified list offered before the first successful discovery.
 *
 * Seeds are ids, not capability claims: a seed that really accepts images would
 * otherwise be refused before the first catalogue read, and one that does not
 * would fail mid-turn. Every seed is therefore text-only until the gateway
 * states otherwise.
 */
export function seedCatalogue(profile: CodeBuddyProfile): CatalogueModel[] {
  return profile.seedModels.map(seed => ({
    id: seed.id,
    name: seed.id,
    contextWindow: seed.contextWindow,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    inputModalities: TEXT_ONLY,
  }))
}

/** One discovery attempt's outcome; a failure keeps the caller's previous list. */
export interface DiscoveryResult {
  readonly models: CatalogueModel[]
  /** Set when discovery failed. */
  readonly error?: string
}

/**
 * Fetch the catalogue using one account's access token.
 * @param profile - deployment to interrogate.
 * @param access - bearer token.
 * @param signal - cancellation.
 * @returns discovered models, or the failure that kept the previous list.
 */
export async function discoverModels(
  profile: CodeBuddyProfile,
  access: string,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  let response: Response
  try {
    response = await fetch(profile.configUrl, {
      method: 'GET',
      headers: profile.headers(access),
      signal,
    })
  }
  catch (error) {
    if (signal.aborted) return { models: [], error: 'cancelled' }
    return { models: [], error: 'unreachable: ' + redact(error instanceof Error ? error.message : String(error)) }
  }
  const text = await response.text()
  if (!response.ok) return { models: [], error: 'HTTP ' + String(response.status) }
  const models = parseCatalogue(text)
  return models.length > 0 ? { models } : { models: [], error: 'catalogue was empty' }
}
