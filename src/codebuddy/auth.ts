/**
 * OAuth for one CodeBuddy profile, plus the credential-record helpers the
 * adapter and the /codebuddy command share.
 *
 * Flow (transcribed from the reference implementation):
 *   POST {stateUrl}?platform=CLI  -> { code: 0, data: { state, authUrl } }
 *   user opens authUrl in a browser and authorises
 *   GET  {tokenUrl}?state=...     -> { code: 0, data: { accessToken, refreshToken, expiresIn } }
 *   POST {refreshUrl}             -> same token payload, token in X-Refresh-Token
 *
 * There is no redirect listener and no callback paste: the polling request
 * carries the state. Code 11217 means "still waiting".
 *
 * @module dsh-native-tui/codebuddy/auth
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { redact } from './errors.js'
import type { CodeBuddyProfile } from './profiles.js'
import { credentialExpiresAt } from './profiles.js'

/** Reference polling cadence and ceiling. */
export const POLL_INTERVAL_MS = 5_000
export const POLL_TIMEOUT_MS = 5 * 60 * 1000

/** Gateway code for "authorisation not completed yet". */
const PENDING_CODE = 11217

/** Deterministic refusals: retrying with the same credential cannot succeed. */
const FATAL_CODES = new Set([12153])

/** The credential record this plugin stores for one deployment, verbatim JSON. */
export interface CodeBuddyGrant {
  /** Bearer token for upstream requests. */
  readonly access: string
  /** Rotation token; empty when the gateway issued none. */
  readonly refresh: string
  /** Epoch ms at which the access token must be rotated before use. */
  readonly expires: number
}

/** The credential seam slice this plugin reads and writes. */
export interface CredentialStoreLike {
  readRecord(key: string): Promise<CredentialRecordLike | undefined>
  modifyRecord(
    key: string,
    mutate: (current: CredentialRecordLike | undefined) => Promise<CredentialRecordLike | undefined>,
  ): Promise<CredentialRecordLike | undefined>
  deleteRecord(key: string): Promise<void>
}

/** One stored record, as the seam carries it. */
export interface CredentialRecordLike {
  readonly kind: string
  readonly payload?: unknown
}

/** The authorization-session slice the login flow drives. */
export interface LoginSession {
  readonly signal: AbortSignal
  notify(notice: { message: string; url?: string; code?: string }): void
  commit(record: { kind: 'grant'; payload: unknown }): Promise<void>
}

/**
 * Credential record address for one deployment: the plugin's registered name
 * plus the route key.
 * @param profile - deployment whose record is addressed.
 * @returns the record key the seam stores it under.
 */
export function credentialKeyFor(profile: CodeBuddyProfile): string {
  return 'codebuddy/' + profile.id
}

/** Upstream answered 2xx but not with a code: 0 payload, or a refusal outright. */
export class GatewayError extends Error {
  readonly code: number | undefined
  readonly fatal: boolean

  constructor(message: string, code: number | undefined, fatal = false) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.fatal = fatal
  }
}

interface TokenPayload {
  accessToken?: unknown
  refreshToken?: unknown
  expiresIn?: unknown
}

interface StatePayload {
  state?: unknown
  authUrl?: unknown
}

interface GatewayResponse<T> {
  code?: unknown
  msg?: unknown
  message?: unknown
  data?: T
}

const NO_AUTH_HEADERS: Readonly<Record<string, string>> = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
}

function numericCode(body: GatewayResponse<unknown>): number | undefined {
  return typeof body.code === 'number' ? body.code : undefined
}

function describeCode(profile: CodeBuddyProfile, body: GatewayResponse<unknown>): string {
  const message = typeof body.msg === 'string' ? body.msg : body.message
  const code = numericCode(body)
  return profile.id + ' ' + String(code ?? '?') + ': ' + redact(typeof message === 'string' ? message : 'unexpected response')
}

function describeBody(profile: CodeBuddyProfile, status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown }
    const code = typeof body.code === 'number' ? ' ' + String(body.code) : ''
    const message = typeof body.msg === 'string' ? body.msg : body.message
    if (typeof message === 'string' && message !== '') return profile.id + code + ': ' + redact(message)
  }
  catch {
    // Not JSON: fall through to the truncated raw text.
  }
  return profile.id + ' upstream ' + String(status) + ': ' + redact(text.slice(0, 200))
}

async function readGatewayResponse<T>(
  profile: CodeBuddyProfile,
  response: Response,
): Promise<GatewayResponse<T>> {
  const text = await response.text()
  if (!response.ok) throw new GatewayError(describeBody(profile, response.status, text), undefined)
  try {
    return JSON.parse(text) as GatewayResponse<T>
  }
  catch {
    throw new GatewayError(profile.id + ' upstream ' + String(response.status) + ': not JSON', undefined)
  }
}

/**
 * Turn one successful token payload into the grant this plugin stores.
 * @param data - gateway token payload.
 * @param now - current epoch ms.
 * @returns the grant to persist.
 * @throws {GatewayError} when the payload carries no access token.
 */
export function toGrant(data: TokenPayload, now = Date.now()): CodeBuddyGrant {
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new GatewayError('login response carried no accessToken', undefined)
  }
  return {
    access: data.accessToken,
    refresh: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    expires: credentialExpiresAt(data.expiresIn, now),
  }
}

/** Ask the gateway for an authorisation URL. */
async function requestLoginUrl(
  profile: CodeBuddyProfile,
  signal: AbortSignal | undefined,
): Promise<{ state: string; authUrl: string }> {
  const response = await fetch(profile.stateUrl + '?platform=CLI', {
    method: 'POST',
    headers: profile.headers(undefined, { 'X-Domain': profile.domain, ...NO_AUTH_HEADERS }),
    body: '{}',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await readGatewayResponse<StatePayload>(profile, response)
  const state = body.data?.state
  const authUrl = body.data?.authUrl
  if (body.code !== 0 || typeof state !== 'string' || typeof authUrl !== 'string') {
    throw new GatewayError(describeCode(profile, body), numericCode(body))
  }
  return { state, authUrl }
}

/** One poll step. Returns undefined while the user has not finished yet. */
async function pollToken(
  profile: CodeBuddyProfile,
  state: string,
  signal: AbortSignal | undefined,
): Promise<CodeBuddyGrant | undefined> {
  const response = await fetch(profile.tokenUrl + '?state=' + encodeURIComponent(state), {
    method: 'GET',
    headers: profile.headers(undefined, {
      'X-Domain': profile.domain,
      ...NO_AUTH_HEADERS,
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) return undefined
  const body = await readGatewayResponse<TokenPayload>(profile, response)
  if (body.code === PENDING_CODE) return undefined
  if (body.code !== 0 || body.data === undefined) {
    const code = numericCode(body)
    throw new GatewayError(describeCode(profile, body), code, code !== undefined && FATAL_CODES.has(code))
  }
  return toGrant(body.data)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal !== undefined && signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Full interactive login. Resolves once the grant is committed through the
 * authorization session; rejects on timeout, cancellation or a deterministic
 * gateway refusal. No timer or request outlives the returned promise.
 * @param profile - deployment being authorized.
 * @param session - the attempt's notices, cancellation and commit path.
 * @returns the committed grant.
 */
export async function login(profile: CodeBuddyProfile, session: LoginSession): Promise<CodeBuddyGrant> {
  const signal = session.signal
  session.notify({ message: profile.id + ': requesting an authorization link' })
  const { state, authUrl } = await requestLoginUrl(profile, signal)
  session.notify({
    url: authUrl,
    message: 'Authorize ' + profile.name + ' in the browser, then return here. Waiting up to '
      + String(POLL_TIMEOUT_MS / 60_000) + ' minutes.',
  })

  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (signal.aborted) throw new Error('login cancelled')
    if (Date.now() >= deadline) throw new Error(profile.id + ': login timed out, run /codebuddy login again')
    await sleep(POLL_INTERVAL_MS, signal)
    const grant = await pollToken(profile, state, signal)
    if (grant !== undefined) {
      await session.commit({ kind: 'grant', payload: grant })
      session.notify({ message: profile.id + ': authorization complete' })
      return grant
    }
  }
}

/**
 * Rotate an access token.
 *
 * The caller is expected to run this inside the credential seam's record lock
 * (modifyRecord), which is what serializes concurrent rotations across
 * processes.
 * @param profile - deployment being rotated.
 * @param grant - the currently stored grant.
 * @param signal - cancellation for the rotation request.
 * @returns the next grant; the previous refresh token is kept when the gateway omits a new one.
 */
export async function refreshGrant(
  profile: CodeBuddyProfile,
  grant: CodeBuddyGrant,
  signal: AbortSignal | undefined,
): Promise<CodeBuddyGrant> {
  if (grant.refresh === '') {
    throw new GatewayError(profile.id + ': no refresh token, run /codebuddy login ' + profile.id, undefined, true)
  }
  const response = await fetch(profile.refreshUrl, {
    method: 'POST',
    headers: profile.headers(undefined, {
      'X-Refresh-Token': grant.refresh,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': profile.domain,
      'Content-Type': 'application/json',
    }),
    body: '{}',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await readGatewayResponse<TokenPayload>(profile, response)
  if (body.code !== 0 || body.data === undefined) {
    const code = numericCode(body)
    throw new GatewayError(describeCode(profile, body), code, code !== undefined && FATAL_CODES.has(code))
  }
  const next = toGrant(body.data)
  return typeof body.data.refreshToken === 'string' && body.data.refreshToken !== ''
    ? next
    : { ...next, refresh: grant.refresh }
}

/**
 * Read the stored grant for one deployment.
 * @param store - the credential seam.
 * @param profile - deployment to read.
 * @returns the grant, or undefined when nothing is stored.
 */
export async function readGrant(
  store: CredentialStoreLike,
  profile: CodeBuddyProfile,
): Promise<CodeBuddyGrant | undefined> {
  const record = await store.readRecord(credentialKeyFor(profile))
  return grantOf(record)
}

/** Narrow one stored record to this plugin's grant format. */
export function grantOf(record: CredentialRecordLike | undefined): CodeBuddyGrant | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const { access, refresh, expires } = payload as { access?: unknown; refresh?: unknown; expires?: unknown }
  if (typeof access !== 'string' || access === '') return undefined
  return {
    access,
    refresh: typeof refresh === 'string' ? refresh : '',
    expires: typeof expires === 'number' && Number.isFinite(expires) ? expires : 0,
  }
}

/**
 * Resolve a request-ready access token, rotating the stored grant first when it
 * is due.
 * @param store - the credential seam.
 * @param profile - deployment to authenticate.
 * @param signal - cancellation for a rotation request.
 * @param force - rotate even when the stored grant is not yet due (one controlled 401 replay).
 * @returns the bearer token to send.
 * @throws {LlmError} code MISSING_CREDENTIAL when nothing is stored, AUTH when rotation fails.
 */
export async function accessToken(
  store: CredentialStoreLike,
  profile: CodeBuddyProfile,
  signal: AbortSignal | undefined,
  force = false,
): Promise<string> {
  const initial = await readGrant(store, profile)
  if (initial === undefined) {
    throw new LlmError(
      profile.id + ': not signed in. Run /codebuddy login ' + profile.id + ' to authorize this account.',
      'MISSING_CREDENTIAL',
    )
  }
  if (!force && initial.expires > Date.now()) return initial.access

  let rotated: CredentialRecordLike | undefined
  try {
    rotated = await store.modifyRecord(credentialKeyFor(profile), async (current) => {
      const grant = grantOf(current)
      // Nothing readable to rotate: leave the stored record alone and let the
      // caller's next read report the real state.
      if (grant === undefined) return undefined
      // Another process rotated while this one waited for the lock.
      if (!force && grant.expires > Date.now()) return undefined
      return { kind: 'grant', payload: await refreshGrant(profile, grant, signal) }
    })
  }
  catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError(
      profile.id + ': credential rotation failed: ' + redact(error instanceof Error ? error.message : String(error)),
      error instanceof GatewayError && error.fatal ? 'MISSING_CREDENTIAL' : 'AUTH',
      { cause: error },
    )
  }
  const grant = grantOf(rotated) ?? initial
  return grant.access
}

/**
 * Delete the stored grant for one deployment.
 * @param store - the credential seam.
 * @param profile - deployment to sign out of.
 */
export async function logout(store: CredentialStoreLike, profile: CodeBuddyProfile): Promise<void> {
  await store.deleteRecord(credentialKeyFor(profile))
}
