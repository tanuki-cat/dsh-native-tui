/**
 * Remaining-credit summary and the explicit daily check-in.
 *
 * Both live on the gateway's billing/meter endpoints and need the account
 * access token, so they are only reachable once signed in. Neither is ever
 * called automatically: the summary runs when the user asks for it, and the
 * check-in only when the user types /codebuddy checkin.
 *
 * @module dsh-native-tui/codebuddy/credits
 */

import { redact } from './errors.js'
import type { CodeBuddyProfile } from './profiles.js'

/**
 * A package whose billing cycle ends more than this long before the resource
 * itself expires is the base package that renews every cycle.
 */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000

/** The gateway's "you already checked in today" code; HTTP 400 carries it. */
export const ALREADY_CHECKED_IN_CODE = 10001

/** One billing package on the account. */
export interface QuotaPackage {
  /** Credits still available in this package. */
  readonly remaining: number
  /** True for the renewing base package, false for a one-off grant. */
  readonly refill: boolean
}

/** Remaining credits across every package. */
export interface QuotaSummary {
  readonly remaining: number
  readonly packages: readonly QuotaPackage[]
}

/** A quota read either produced a summary or explained why it could not. */
export type QuotaResult = { readonly ok: true; readonly summary: QuotaSummary } | { readonly ok: false; readonly error: string }

/** An attempted check-in, in the gateway's own vocabulary. */
export type CheckinResult =
  | { readonly status: 'checked-in'; readonly credit: number; readonly streakDays?: number }
  | { readonly status: 'already' }
  | { readonly status: 'failed'; readonly error: string }

/**
 * Credits come as a number plus a string mirror for precision. The string wins
 * when it parses; otherwise the number is used, so a missing or malformed
 * precise field cannot turn a known balance into zero.
 */
function creditValue(preciseValue: unknown, plain: unknown): number {
  for (const value of [preciseValue, plain]) {
    if (value === undefined || value === null || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function isRefillPackage(account: Record<string, unknown>): boolean {
  const cycleEnd = typeof account.CycleEndTime === 'string' ? Date.parse(account.CycleEndTime) : Number.NaN
  const deductionEnd = Number(account.DeductionEndTime)
  return Number.isFinite(cycleEnd) && Number.isFinite(deductionEnd) && deductionEnd - cycleEnd > REFILL_GAP_MS
}

/**
 * Sum the remaining credits across every package on the account.
 *
 * TotalDosage is deliberately not read: it is the cumulative amount already
 * consumed, not what is left. Renewing packages and one-off grants report their
 * remainder in different fields, so the package kind decides which pair to read.
 * @param accounts - the gateway's account list.
 * @returns the summed summary.
 */
export function summarizeAccounts(accounts: readonly unknown[]): QuotaSummary {
  const packages: QuotaPackage[] = []
  for (const entry of accounts) {
    if (entry === null || typeof entry !== 'object') continue
    const account = entry as Record<string, unknown>
    const refill = isRefillPackage(account)
    packages.push({
      refill,
      remaining: refill
        ? creditValue(account.CycleCapacityRemainPrecise, account.CycleCapacityRemain)
        : creditValue(account.CapacityRemainPrecise, account.CapacityRemain),
    })
  }
  const remaining = packages.reduce((sum, entry) => sum + entry.remaining, 0)
  return { remaining: Math.round(remaining * 100) / 100, packages }
}

/**
 * Pull the account list out of a get-user-resource body.
 * @param body - parsed response body.
 * @returns the summary, or undefined when the shape is not the expected one.
 */
export function parseQuota(body: unknown): QuotaSummary | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const response = body as { code?: unknown; data?: { Response?: { Data?: { Accounts?: unknown } } } }
  if (response.code !== 0) return undefined
  const accounts = response.data?.Response?.Data?.Accounts
  return Array.isArray(accounts) ? summarizeAccounts(accounts) : undefined
}

function businessCode(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const code = (body as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

function messageOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as { msg?: unknown; message?: unknown }
  const message = typeof record.msg === 'string' ? record.msg : record.message
  return typeof message === 'string' && message !== '' ? redact(message) : undefined
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/**
 * POST an empty JSON body to the first endpoint that does not answer 404/405 —
 * the same rule the chat endpoint uses.
 */
async function postMeter(
  profile: CodeBuddyProfile,
  urls: readonly string[],
  access: string,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response | undefined
  for (const [index, url] of urls.entries()) {
    response = await fetch(url, {
      method: 'POST',
      headers: profile.headers(access, { 'Content-Type': 'application/json' }),
      body: '{}',
      signal,
    })
    if (index < urls.length - 1 && (response.status === 404 || response.status === 405)) continue
    return response
  }
  throw new Error(profile.id + ': no billing endpoint configured')
}

function transportError(profile: CodeBuddyProfile, error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'cancelled'
  return profile.id + ' unreachable: ' + redact(error instanceof Error ? error.message : String(error))
}

/**
 * Read the remaining credits for one account.
 * @param profile - deployment to interrogate.
 * @param access - bearer token.
 * @param signal - cancellation.
 * @returns the summary, or the reason it could not be read.
 */
export async function fetchQuota(
  profile: CodeBuddyProfile,
  access: string,
  signal: AbortSignal,
): Promise<QuotaResult> {
  let response: Response
  try {
    response = await postMeter(profile, profile.usageUrls, access, signal)
  }
  catch (error) {
    return { ok: false, error: transportError(profile, error, signal) }
  }
  const body = await readBody(response)
  if (!response.ok) {
    const detail = messageOf(body)
    return { ok: false, error: 'HTTP ' + String(response.status) + (detail === undefined ? '' : ' — ' + detail) }
  }
  const summary = parseQuota(body)
  if (summary === undefined) {
    return {
      ok: false,
      error: 'unexpected response (code=' + String(businessCode(body) ?? '?') + '), the endpoint shape may have changed',
    }
  }
  return { ok: true, summary }
}

/**
 * Claim today's check-in.
 *
 * The gateway answers code 10001 with HTTP 400 when the day's credits were
 * already claimed, which is why the body is parsed before the status is judged.
 * @param profile - deployment to claim for.
 * @param access - bearer token.
 * @param signal - cancellation.
 * @returns the claim's outcome.
 */
export async function checkIn(
  profile: CodeBuddyProfile,
  access: string,
  signal: AbortSignal,
): Promise<CheckinResult> {
  let response: Response
  try {
    response = await postMeter(profile, profile.checkinUrls, access, signal)
  }
  catch (error) {
    return { status: 'failed', error: transportError(profile, error, signal) }
  }
  const body = await readBody(response)
  const code = businessCode(body)

  if (code === ALREADY_CHECKED_IN_CODE) return { status: 'already' }
  if (code !== undefined && code !== 0) {
    return { status: 'failed', error: messageOf(body) ?? 'gateway code ' + String(code) }
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ' (this credential is no longer accepted)' : ''
    const detail = messageOf(body)
    return { status: 'failed', error: 'HTTP ' + String(response.status) + hint + (detail === undefined ? '' : ' — ' + detail) }
  }

  const data = body !== null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const credit = Number(record?.credit)
  const streak = Number(record?.streak_days)
  return {
    status: 'checked-in',
    credit: Number.isFinite(credit) ? credit : 0,
    ...(Number.isFinite(streak) ? { streakDays: streak } : {}),
  }
}
