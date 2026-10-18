/**
 * Per-upstream profiles: everything that differs between the two CodeBuddy
 * deployments. Auth, discovery, streaming and credits read these tables.
 *
 * Protocol facts (endpoints, headers, endpoint fallback rules, payload
 * normalization) are transcribed from `CARVIN94/dsh-router-codebuddy@0.3.22` (MIT);
 * see the design doc and README for provenance. Constants a live account could
 * falsify are marked "unverified" where declared.
 *
 * @module dsh-native-tui/codebuddy/profiles
 */

/** Route key of one deployment; also the credential record id. */
export type ProfileId = 'codebuddy' | 'codebuddy-en'

/** A model entry used before the first successful catalogue discovery. */
export interface SeedModel {
  readonly id: string
  readonly contextWindow: number
}

/** One deployment's endpoints, headers and catalogue defaults. */
export interface CodeBuddyProfile {
  /** DSH route key; also the credential record id. Never rename. */
  readonly id: ProfileId
  /** Display name for selectors and diagnostics. */
  readonly name: string
  /**
   * Chat endpoint base URLs in try order. Only the first is used unless the
   * upstream rejects it with 404/405.
   */
  readonly chatBaseUrls: readonly string[]
  /** Cloud product config endpoint used for model discovery. */
  readonly configUrl: string
  /** OAuth: create state / poll token / rotate token. */
  readonly stateUrl: string
  readonly tokenUrl: string
  readonly refreshUrl: string
  /** Upstream domain, sent as `X-Domain`. */
  readonly domain: string
  /** Billing/meter endpoints for the remaining-credit summary, in try order. */
  readonly usageUrls: readonly string[]
  /** Daily check-in endpoints, in try order. */
  readonly checkinUrls: readonly string[]
  /** Outbound request headers; Authorization is appended when a token is given. */
  headers(token?: string, extra?: Record<string, string>): Record<string, string>
  /** Extra headers the chat endpoint needs on top of `headers`. */
  readonly chatExtraHeaders?: Record<string, string>
  /** Extra outbound payload normalization; only the international gateway needs it. */
  readonly normalizePayload?: (payload: Record<string, unknown>) => void
  /** Emergency model list, replaced by discovery on the first successful refresh. */
  readonly seedModels: readonly SeedModel[]
}

/**
 * The verified chat-completions request shape.
 *
 * - no `store` field;
 * - no `stream_options` (so token usage is absent rather than fabricated zero);
 * - `max_tokens` rather than `max_completion_tokens`;
 * - system prompts use the `system` role (the international gateway rejects
 *   `developer` with upstream code 11128);
 * - thinking is carried by `reasoning_effort` + `reasoning_summary`.
 */
export const REQUEST_SHAPE = {
  maxTokensField: 'max_tokens',
  supportsStore: false,
  supportsUsageInStreaming: false,
  supportsDeveloperRole: false,
} as const

// ---------------------------------------------------------------------------
// Credential lifetime
// ---------------------------------------------------------------------------

/** Refresh this long before the upstream expiry. */
export const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * Rotate the access token at least this often even when the upstream expiry is
 * far away; the reference rotates after 15 days.
 */
export const REFRESH_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000

/** Assumed lifetime when the upstream omits `expiresIn`. */
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Floor so a very short-lived token cannot produce a refresh loop. */
const MIN_REFRESH_DELAY_MS = 60 * 1000

/**
 * DSH-visible expiry for a freshly issued token: the moment it should rotate.
 * @param expiresInSeconds - upstream lifetime in seconds, when it states one.
 * @param now - current epoch ms.
 * @returns epoch ms at which a request must refresh before use.
 */
export function credentialExpiresAt(expiresInSeconds: unknown, now = Date.now()): number {
  const ttlSeconds = Number(expiresInSeconds)
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : DEFAULT_TOKEN_TTL_MS
  const delay = ttl > REFRESH_SKEW_MS
    ? Math.min(ttl - REFRESH_SKEW_MS, REFRESH_MAX_AGE_MS)
    : Math.max(ttl / 2, MIN_REFRESH_DELAY_MS)
  return now + delay
}

// ---------------------------------------------------------------------------
// Model shape defaults
// ---------------------------------------------------------------------------

/** Context window assumed for a discovered model with no usable `maxInputTokens`. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Output cap used when the catalogue states no usable `maxOutputTokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

// ---------------------------------------------------------------------------
// International-gateway payload normalization
// ---------------------------------------------------------------------------

/**
 * `tool_choice: "none"` has no upstream spelling on the international gateway
 * (code 11101), so `none` is expressed by dropping the field together with the
 * tool declarations.
 * @param payload - outbound chat body, modified in place.
 */
export function normalizeEnPayload(payload: Record<string, unknown>): void {
  if (payload.tool_choice !== 'none') return
  delete payload.tool_choice
  delete payload.tools
  delete payload.functions
}

/** Reasoning fields the gateway needs together to emit thinking content. */
export const REASONING_SUMMARY = 'auto'

// ---------------------------------------------------------------------------
// China deployment — https://copilot.tencent.com
// ---------------------------------------------------------------------------

const CN_BASE = 'https://copilot.tencent.com'

/** unverified: last-resort list for a fresh install with no network and no prior discovery. */
const CN_SEED_MODELS: readonly SeedModel[] = [
  { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
  { id: 'glm-5.3', contextWindow: 1_000_000 },
  { id: 'glm-5.3-flash', contextWindow: 1_000_000 },
  { id: 'minimax-m3', contextWindow: 512_000 },
  { id: 'kimi-k3-1', contextWindow: 1_000_000 },
  { id: 'hy3', contextWindow: 192_000 },
  { id: 'hunyuan-chat', contextWindow: 200_000 },
]

function cnHeaders(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'CLI/2.108.1 CodeBuddy/2.108.1',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    ...extra,
  }
  if (token !== undefined && token !== '') headers.Authorization = 'Bearer ' + token
  return headers
}

/** China CodeBuddy deployment. */
export const cnProfile: CodeBuddyProfile = {
  id: 'codebuddy',
  name: 'CodeBuddy (CN)',
  chatBaseUrls: [CN_BASE + '/v2'],
  configUrl: CN_BASE + '/v3/config',
  stateUrl: CN_BASE + '/v2/plugin/auth/state',
  tokenUrl: CN_BASE + '/v2/plugin/auth/token',
  refreshUrl: CN_BASE + '/v2/plugin/auth/token/refresh',
  usageUrls: [CN_BASE + '/v2/billing/meter/get-user-resource'],
  checkinUrls: [CN_BASE + '/billing/meter/daily-checkin'],
  domain: 'copilot.tencent.com',
  headers: cnHeaders,
  seedModels: CN_SEED_MODELS,
}

// ---------------------------------------------------------------------------
// International deployment — https://www.workbuddy.ai
// ---------------------------------------------------------------------------

const EN_BASE = 'https://www.workbuddy.ai'

/** unverified: same role as the CN seed list, for the international catalogue. */
const EN_SEED_MODELS: readonly SeedModel[] = [
  { id: 'gpt-5.6-sol', contextWindow: 1_000_000 },
  { id: 'gpt-5.6-terra', contextWindow: 1_000_000 },
  { id: 'gpt-5.5', contextWindow: 1_000_000 },
  { id: 'gpt-5.4', contextWindow: 512_000 },
  { id: 'gemini-3.5-flash', contextWindow: 1_000_000 },
  { id: 'kimi-k3', contextWindow: 1_000_000 },
]

function enHeaders(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1',
    Origin: EN_BASE,
    Referer: EN_BASE + '/',
    'Accept-Language': 'en-US',
    'X-No-Enterprise-Id': '1',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    ...extra,
  }
  if (token !== undefined && token !== '') headers.Authorization = 'Bearer ' + token
  return headers
}

/** International WorkBuddy deployment. */
export const enProfile: CodeBuddyProfile = {
  id: 'codebuddy-en',
  name: 'CodeBuddy (WorkBuddy EN)',
  chatBaseUrls: [EN_BASE + '/console', EN_BASE + '/v2'],
  configUrl: EN_BASE + '/v3/config',
  stateUrl: EN_BASE + '/v2/plugin/auth/state',
  tokenUrl: EN_BASE + '/v2/plugin/auth/token',
  refreshUrl: EN_BASE + '/v2/plugin/auth/token/refresh',
  usageUrls: [EN_BASE + '/billing/meter/get-user-resource', EN_BASE + '/v2/billing/meter/get-user-resource'],
  checkinUrls: [EN_BASE + '/billing/meter/daily-checkin', EN_BASE + '/v2/billing/meter/daily-checkin'],
  domain: 'www.workbuddy.ai',
  headers: enHeaders,
  chatExtraHeaders: { Accept: 'application/json, text/event-stream' },
  normalizePayload: normalizeEnPayload,
  seedModels: EN_SEED_MODELS,
}

/** Both deployments, in command-argument order. */
export const PROFILES: readonly CodeBuddyProfile[] = [cnProfile, enProfile]

/**
 * Resolve one profile by route id.
 * @param id - route id or nothing.
 * @returns the profile, or undefined when the id names neither deployment.
 */
export function getProfile(id: string): CodeBuddyProfile | undefined {
  return PROFILES.find(profile => profile.id === id)
}

/** Short command-argument aliases for the two deployments. */
export const PROFILE_ALIASES: Readonly<Record<string, ProfileId>> = { cn: 'codebuddy', en: 'codebuddy-en' }
