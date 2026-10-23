/**
 * Read the ChatGPT Codex rate-limit windows for the signed-in account.
 *
 * The endpoint is the one the Codex CLI and the reference plugin use; it is
 * undocumented and unversioned, so every field is validated here. A surprise
 * only degrades the usage block: `/codex status` still reports the sign-in
 * state without it.
 *
 * @module dsh-native-tui/codex/usage
 */

/** Seconds in the ChatGPT five-hour window. */
export const FIVE_HOUR_SECONDS = 18_000

/** Seconds in the ChatGPT weekly window. */
export const WEEK_SECONDS = 604_800

/** Backend endpoint that reports the account's remaining windows. */
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Request budget; status is interactive, so this stays well under a turn. */
export const USAGE_TIMEOUT_MS = 10_000

/** Largest response body accepted, so a broken proxy cannot buffer unbounded data. */
const MAX_BODY_LENGTH = 256 * 1024

/** Largest epoch-ms timestamp a reset time may name. */
const MAX_TIMESTAMP = 8.64e15

/** One quota window that is due to reset. */
export interface UsageWindow {
  /** Percentage the account already consumed, 0–100. */
  readonly usedPercent: number
  /** Percentage still available, 0–100. */
  readonly remainingPercent: number
  /** Length of the window in seconds. */
  readonly windowSeconds: number
  /** When the window resets, epoch ms, when the service reported it. */
  readonly resetsAt?: number
}

/** Why one window is missing from the snapshot. */
export type UsageWindowReason = 'not-returned' | 'invalid-response' | 'expired'

/** Validated quota data for one account. */
export interface UsageSnapshot {
  readonly fetchedAt: number
  readonly fiveHour?: UsageWindow
  readonly weekly?: UsageWindow
  readonly fiveHourReason?: UsageWindowReason
  readonly weeklyReason?: UsageWindowReason
  /** `rate_limit.allowed`; false means calls fail until a window resets. */
  readonly allowed?: boolean
}

/** Why the whole usage read failed. */
export type UsageReason =
  | 'cancelled'
  | 'credential-expired'
  | 'permission-denied'
  | 'rate-limited'
  | 'network-error'
  | 'timeout'
  | 'invalid-response'
  | 'account-changed'

/** One usage read, either the windows or a reason they are missing. */
export type UsageResult =
  | { readonly kind: 'ok'; readonly usage: UsageSnapshot }
  | { readonly kind: 'unavailable'; readonly reason: UsageReason }

/** Everything one usage read needs. */
export interface UsageFetchOptions {
  /** OAuth access token from the stored grant. Never logged. */
  readonly access: string
  /** ChatGPT account id; the endpoint scopes the answer with it. */
  readonly accountId: string
  /** Terminal or command lifetime signal. */
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
}

/** Whether a value is a non-array object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One window's parsed form, keeping the length even when the rest is broken. */
interface ParsedWindow {
  readonly seconds?: number
  readonly window?: UsageWindow
  readonly reason?: UsageWindowReason
}

/** One reset time, or a marker that the field was malformed. */
type ResetAt = { readonly ok: true; readonly at?: number } | { readonly ok: false }

/** Window length in seconds, accepting the minute-based spelling newer builds use. */
function windowSecondsOf(value: Record<string, unknown>): number | undefined {
  const seconds = value.limit_window_seconds
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return seconds
  const minutes = value.window_minutes ?? value.window_duration_mins
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return minutes * 60
  return undefined
}

/** Reset time as epoch ms, preferring the absolute field over the countdown. */
function resetAtOf(value: Record<string, unknown>, now: number): ResetAt {
  const absolute = value.reset_at ?? value.resets_at
  if (absolute !== undefined) {
    if (typeof absolute !== 'number' || !Number.isFinite(absolute) || absolute <= 0 || absolute * 1000 > MAX_TIMESTAMP) {
      return { ok: false }
    }
    return { ok: true, at: Math.round(absolute * 1000) }
  }
  const relative = value.reset_after_seconds
  if (relative !== undefined) {
    if (typeof relative !== 'number' || !Number.isFinite(relative) || relative < 0) return { ok: false }
    return { ok: true, at: now + Math.round(relative * 1000) }
  }
  return { ok: true }
}

/** Validate one window object without letting it invalidate its sibling. */
function parseWindow(raw: unknown, now: number): ParsedWindow {
  const value = objectOf(raw)
  if (value === undefined) return { reason: 'invalid-response' }
  const seconds = windowSecondsOf(value)
  if (seconds === undefined) return { reason: 'invalid-response' }
  const used = value.used_percent
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
    return { seconds, reason: 'invalid-response' }
  }
  const reset = resetAtOf(value, now)
  if (!reset.ok) return { seconds, reason: 'invalid-response' }
  if (reset.at !== undefined && reset.at <= now) return { seconds, reason: 'expired' }
  return {
    seconds,
    window: {
      usedPercent: used,
      remainingPercent: 100 - used,
      windowSeconds: seconds,
      ...(reset.at === undefined ? {} : { resetsAt: reset.at }),
    },
  }
}

/** Pick the single window whose length matches, or explain why there is none. */
function pickWindow(windows: readonly ParsedWindow[], seconds: number): { readonly window?: UsageWindow; readonly reason?: UsageWindowReason } {
  const matches = windows.filter(candidate => candidate.seconds === seconds)
  if (matches.length === 0) return { reason: 'not-returned' }
  if (matches.length > 1) return { reason: 'invalid-response' }
  const only = matches[0]
  if (only?.window === undefined) return { reason: only?.reason ?? 'invalid-response' }
  return { window: only.window }
}

/**
 * Validate one `wham/usage` body.
 * @param value - the parsed JSON body.
 * @param now - current epoch ms, used for countdown resets and expiry checks.
 * @param accountId - the account the stored credential belongs to.
 * @returns the windows, or why the body cannot be shown.
 */
export function parseUsageSnapshot(value: unknown, now: number, accountId: string): UsageResult {
  const root = objectOf(value)
  if (root === undefined) return { kind: 'unavailable', reason: 'invalid-response' }
  const reported = root.account_id
  if (reported !== undefined) {
    if (typeof reported !== 'string') return { kind: 'unavailable', reason: 'invalid-response' }
    if (reported !== accountId) return { kind: 'unavailable', reason: 'account-changed' }
  }
  const rate = root.rate_limit
  if (rate !== undefined && rate !== null && objectOf(rate) === undefined) {
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  const limit = objectOf(rate) ?? {}
  const windows = [limit.primary_window, limit.secondary_window]
    .filter(raw => raw !== undefined && raw !== null)
    .map(raw => parseWindow(raw, now))
  const five = pickWindow(windows, FIVE_HOUR_SECONDS)
  const week = pickWindow(windows, WEEK_SECONDS)
  return {
    kind: 'ok',
    usage: {
      fetchedAt: now,
      ...(five.window === undefined ? {} : { fiveHour: five.window }),
      ...(five.reason === undefined ? {} : { fiveHourReason: five.reason }),
      ...(week.window === undefined ? {} : { weekly: week.window }),
      ...(week.reason === undefined ? {} : { weeklyReason: week.reason }),
      ...(typeof limit.allowed === 'boolean' ? { allowed: limit.allowed } : {}),
    },
  }
}

/** Release an unread body so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Read the account's usage windows.
 * @param options - credential, signal and injectable transport.
 * @returns the windows, or the reason the read failed.
 */
export async function fetchCodexUsage(options: UsageFetchOptions): Promise<UsageResult> {
  const now = options.now ?? Date.now
  const fetcher = options.fetcher ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? USAGE_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])
  const failure = (): UsageResult => ({
    kind: 'unavailable',
    reason: options.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'network-error',
  })
  let response: Response
  try {
    response = await fetcher(USAGE_URL, {
      headers: {
        authorization: 'Bearer ' + options.access,
        'ChatGPT-Account-Id': options.accountId,
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
    const reason: UsageReason = response.status === 401
      ? 'credential-expired'
      : response.status === 403
        ? 'permission-denied'
        : response.status === 429
          ? 'rate-limited'
          : 'network-error'
    return { kind: 'unavailable', reason }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) {
    await discard(response)
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  let text: string
  try {
    text = await response.text()
  }
  catch {
    return failure()
  }
  if (text.length > MAX_BODY_LENGTH) return { kind: 'unavailable', reason: 'invalid-response' }
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return { kind: 'unavailable', reason: 'invalid-response' }
  }
  return parseUsageSnapshot(value, now(), options.accountId)
}
