/**
 * Read the account's Codex model catalogue and plan the settings patch.
 *
 * The endpoint is the one the Codex CLI uses; it is undocumented and
 * unversioned, so every field is validated here. A surprise only refuses the
 * patch: nothing is written from an unreadable listing.
 *
 * @module dsh-native-tui/codex/catalog
 */

import { execFile } from 'node:child_process'

/** Backend endpoint that lists the models the account may select. */
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/** Request budget; the command previews before writing, so this stays short. */
export const CATALOG_TIMEOUT_MS = 7_000

/** Largest response body accepted, so a broken proxy cannot buffer unbounded data. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** A listing larger than this is a page or a payload this reader cannot trust. */
export const MAX_CATALOG_MODELS = 500

/** Version named by the request when neither the environment nor a CLI probe answers. */
export const BUILTIN_CLIENT_VERSION = '0.165.0'

/** Output cap written for a model whose listing publishes none. */
export const DEFAULT_CODEX_MAX_OUTPUT_TOKENS = 128_000

/** Semantic version shape the request version must satisfy. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Model ids the listing accepts; anything else means this is not the listing it claims to be. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,100}$/

/** Every reasoning level the Host schema can express, in escalation order. */
const HOST_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Levels offered only as wire spellings; the listing's `ultra` has no Host counterpart. */
const HOST_LEVEL_SET = new Set<string>(HOST_LEVELS)

/** Where the request version came from. */
export type ClientVersionSource = 'environment' | 'codex-cli' | 'builtin'

/** One resolved request version. */
export interface ClientVersion {
  readonly value: string
  readonly source: ClientVersionSource
}

/** A version that could not be used, with the field that caused it. */
export type ClientVersionResult = ClientVersion | { readonly error: 'version-invalid' }

/** Why the catalogue could not be read. */
export type CatalogReason =
  | 'cancelled'
  | 'credential-expired'
  | 'permission-denied'
  | 'rate-limited'
  | 'network-error'
  | 'timeout'
  | 'invalid-response'

/** One model entry a patch can write. */
export interface CatalogEntry {
  readonly id: string
  readonly name?: string
  readonly contextWindow: number
  /** The listing's own output cap; absent when it publishes none. */
  readonly maxTokens?: number
  readonly input: readonly ('text' | 'image')[]
  /** Declared levels, `false` for a model that offers none, absent when unstated. */
  readonly efforts?: false | Readonly<Record<string, string | null>>
  /** Levels the listing declared that this Host cannot express. */
  readonly omitted: readonly string[]
}

/** A readable listing. */
export interface CatalogListing {
  readonly kind: 'ok'
  readonly entries: readonly CatalogEntry[]
  readonly limited: readonly { readonly id: string; readonly omitted: readonly string[] }[]
  readonly unsupported: number
  /** Raw entries read, including the ones the reader skipped. */
  readonly total: number
}

/** One catalogue read, either the listing or why it is missing. */
export type CatalogResult =
  | CatalogListing
  | { readonly kind: 'unavailable'; readonly reason: CatalogReason; readonly status?: number }

/** Everything one catalogue read needs. */
export interface CatalogFetchOptions {
  /** OAuth access token from the stored grant. Never logged. */
  readonly access: string
  /** ChatGPT account id; the endpoint scopes the answer with it. */
  readonly accountId: string
  /** Version the request names, resolved by the caller. */
  readonly clientVersion: string
  /** Terminal or command lifetime signal. */
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
  readonly timeoutMs?: number
}

/** One appended model and the shape it takes in settings. */
export interface CatalogPlan {
  /** Ids appended to the explicit list, in append order. */
  readonly added: readonly string[]
  /** Remote entries among {@link added}, carrying the capabilities to preview. */
  readonly entries: readonly CatalogEntry[]
  /** Ids the patch appended that were not registered before it. */
  readonly newlyAvailable: readonly string[]
  /** Existing explicit ids, preserved verbatim. */
  readonly preserved: readonly string[]
  /** The complete array written to `providers.openai-codex.models`. */
  readonly proposed: readonly unknown[]
  /** Registered ids the listing does not carry; reported, never removed. */
  readonly unlisted: readonly string[]
  readonly limited: readonly { readonly id: string; readonly omitted: readonly string[] }[]
  readonly unsupported: number
}

/** Whether a value is a non-array object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A positive integer field, or undefined when absent or unusable. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** One probe command output, bounded so a broken CLI cannot hang the command. */
function probeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['--version'], { timeout: 1500, maxBuffer: 4096 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Resolve the version the catalogue request names.
 *
 * An override that is not a semantic version fails instead of falling back: the
 * operator asked for a specific contract, and silently using another one would
 * report a different listing under the same request.
 * @param override - `DSH_CODEX_CLIENT_VERSION`, or null when unset.
 * @param probe - CLI probe, injectable for tests.
 * @returns the version and its source, or the invalid-override marker.
 */
export async function resolveClientVersion(
  override: string | null = process.env.DSH_CODEX_CLIENT_VERSION ?? null,
  probe: () => Promise<string> = probeVersion,
): Promise<ClientVersionResult> {
  if (override !== null) {
    if (override.length > 64 || !VERSION_PATTERN.test(override)) return { error: 'version-invalid' }
    return { value: override, source: 'environment' }
  }
  try {
    const match = /^codex(?:-cli)?\s+(\S+)\s*$/.exec((await probe()).trim())
    const value = match?.[1]
    if (value !== undefined && VERSION_PATTERN.test(value)) return { value, source: 'codex-cli' }
  }
  catch {
    // An absent or unavailable CLI leaves the tested request contract in place.
  }
  return { value: BUILTIN_CLIENT_VERSION, source: 'builtin' }
}

/** Declared reasoning levels, mapped to the Host's spellings. */
function effortsOf(levels: readonly unknown[]): { efforts?: false | Record<string, string | null>; omitted: string[] } | undefined {
  if (levels.length === 0) return { efforts: false, omitted: [] }
  const declared = new Map<string, string | null>()
  const omitted: string[] = []
  for (const level of levels) {
    const name = objectOf(level)?.effort
    if (typeof name !== 'string') return undefined
    if (HOST_LEVEL_SET.has(name)) declared.set(name, name)
    else omitted.push(name)
  }
  if (declared.size === 0) return undefined
  // pi-ai maps the smallest level onto the listing's first usable one.
  if (declared.get('low') === 'low' && !declared.has('minimal')) declared.set('minimal', 'low')
  const ordered: Record<string, string | null> = {}
  for (const level of HOST_LEVELS) {
    const wire = declared.get(level)
    if (wire !== undefined) ordered[level] = wire
  }
  return { efforts: ordered, omitted: [...new Set(omitted)].sort() }
}

/**
 * Validate one catalogue body.
 * @param value - the parsed JSON body.
 * @returns the serviceable entries, or the reason the body cannot be used.
 */
export function parseRemoteCatalog(value: unknown): CatalogResult {
  const root = objectOf(value)
  // The endpoint answers one unpaginated page under a single `models` key, so
  // any other envelope shape means this is not the listing it claims to be.
  if (root === undefined || Object.keys(root).some(key => key !== 'models')) {
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  const models = root.models
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_CATALOG_MODELS) {
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  const seen = new Set<string>()
  const entries: CatalogEntry[] = []
  const limited: { readonly id: string; readonly omitted: readonly string[] }[] = []
  let unsupported = 0
  for (const raw of models) {
    const model = objectOf(raw)
    if (model === undefined) return { kind: 'unavailable', reason: 'invalid-response' }
    const slug = model.slug
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || seen.has(slug)) {
      return { kind: 'unavailable', reason: 'invalid-response' }
    }
    seen.add(slug)
    // ChatGPT OAuth permits models even when supported_in_api is false.
    if (model.visibility !== 'list') continue
    // The model's own window wins; `max_context_window` is only the ceiling a
    // configuration override may raise it to, so it is the fallback.
    const contextWindow = positive(model.context_window) ?? positive(model.max_context_window)
    // Codex protocol defaults an omitted input_modalities field to text.
    const modalities = model.input_modalities === undefined ? ['text'] : model.input_modalities
    const levels = model.supported_reasoning_levels
    if (contextWindow === undefined || !Array.isArray(modalities) || modalities.length === 0
      || !modalities.every(modality => modality === 'text' || modality === 'image')
      || !Array.isArray(levels)) {
      unsupported += 1
      continue
    }
    const parsedLevels = effortsOf(levels)
    if (parsedLevels === undefined) {
      unsupported += 1
      continue
    }
    const entry: CatalogEntry = {
      id: slug,
      ...(typeof model.display_name === 'string' && model.display_name !== '' && model.display_name.length <= 150
        ? { name: model.display_name }
        : {}),
      contextWindow,
      ...(positive(model.max_output_tokens) === undefined ? {} : { maxTokens: positive(model.max_output_tokens) as number }),
      input: [...new Set<string>(modalities as string[])].sort() as ('text' | 'image')[],
      ...(parsedLevels.efforts === undefined ? {} : { efforts: parsedLevels.efforts }),
      omitted: parsedLevels.omitted,
    }
    if (parsedLevels.omitted.length > 0) limited.push({ id: entry.id, omitted: parsedLevels.omitted })
    entries.push(entry)
  }
  if (entries.length === 0) return { kind: 'unavailable', reason: 'invalid-response' }
  return { kind: 'ok', entries, limited, unsupported, total: models.length }
}

/** Release an unread body so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Read the account's model catalogue.
 * @param options - credential, version, signal and injectable transport.
 * @returns the listing, or the reason the read failed.
 */
export async function fetchCodexCatalog(options: CatalogFetchOptions): Promise<CatalogResult> {
  const fetcher = options.fetcher ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CATALOG_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])
  const failure = (): CatalogResult => ({
    kind: 'unavailable',
    reason: options.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'network-error',
  })
  // A command that was already cancelled must not cost a request to discover.
  if (options.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' }
  const url = CODEX_MODELS_URL + '?client_version=' + encodeURIComponent(options.clientVersion)
  let response: Response
  try {
    response = await fetcher(url, {
      headers: {
        authorization: 'Bearer ' + options.access,
        'chatgpt-account-id': options.accountId,
        accept: 'application/json',
      },
      redirect: 'error',
      signal,
    })
  }
  catch {
    return failure()
  }
  if (!response.ok) {
    await discard(response)
    const reason: CatalogReason = response.status === 401
      ? 'credential-expired'
      : response.status === 403
        ? 'permission-denied'
        : response.status === 429
          ? 'rate-limited'
          : 'network-error'
    return { kind: 'unavailable', reason, status: response.status }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) {
    await discard(response)
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await discard(response)
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  // The cap is enforced on the bytes actually read: a declared length is only
  // a hint, and a truncated listing is not parseable anyway.
  const reader = response.body?.getReader()
  if (reader === undefined) return { kind: 'unavailable', reason: 'invalid-response' }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { kind: 'unavailable', reason: 'invalid-response' }
      }
      chunks.push(value)
    }
  }
  catch {
    return failure()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  }
  catch {
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  return parseRemoteCatalog(value)
}

/** The settings shape of one remote entry. */
function settingsEntry(entry: CatalogEntry): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: entry.id,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? DEFAULT_CODEX_MAX_OUTPUT_TOKENS,
    input: [...entry.input],
  }
  if (entry.efforts === false) value.reasoningEfforts = false
  else if (entry.efforts !== undefined) value.reasoningEfforts = { ...entry.efforts }
  return value
}

/**
 * Plan the explicit model list a patch writes.
 *
 * Existing explicit entries are preserved verbatim: a user may have chosen a
 * capacity or a level map on purpose, so a stale value is reported rather than
 * rewritten. Models the runtime already registers but the listing does not
 * carry are added as bare ids and listed as unlisted; nothing is removed.
 * @param existing - current `providers.openai-codex.models`.
 * @param native - ids the runtime currently registers.
 * @param listing - the readable remote listing.
 * @returns the patch plan, or the unmergeable marker.
 */
export function planCatalogPatch(
  existing: unknown,
  native: readonly { readonly id: string }[],
  listing: CatalogListing,
): CatalogPlan | { readonly error: 'config-unmergeable' } {
  const preserved: Record<string, unknown>[] = []
  if (existing !== undefined) {
    if (!Array.isArray(existing)) return { error: 'config-unmergeable' }
    const seen = new Set<string>()
    for (const raw of existing) {
      const entry = objectOf(raw)
      const id = entry?.id
      if (entry === undefined || typeof id !== 'string' || id === '' || seen.has(id)) return { error: 'config-unmergeable' }
      seen.add(id)
      preserved.push(entry)
    }
  }
  const registered = new Set(native.map(model => model.id))
  const known = new Set(preserved.map(entry => entry.id as string))
  const proposed: unknown[] = [...preserved]
  const added: string[] = []
  const entries: CatalogEntry[] = []
  const newlyAvailable: string[] = []
  for (const entry of listing.entries) {
    if (known.has(entry.id)) continue
    known.add(entry.id)
    proposed.push(settingsEntry(entry))
    entries.push(entry)
    added.push(entry.id)
    if (!registered.has(entry.id)) newlyAvailable.push(entry.id)
  }
  // Rechecking after an adapter upgrade also brings newly installed ids in.
  for (const model of native) {
    if (known.has(model.id)) continue
    known.add(model.id)
    proposed.push({ id: model.id })
    added.push(model.id)
  }
  const listed = new Set(listing.entries.map(entry => entry.id))
  const unlisted = native.map(model => model.id).filter(id => !listed.has(id))
  return {
    added,
    entries,
    newlyAvailable,
    preserved: preserved.map(entry => entry.id as string),
    proposed,
    unlisted,
    limited: listing.limited,
    unsupported: listing.unsupported,
  }
}
