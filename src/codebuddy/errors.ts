/**
 * Upstream failure classification and log redaction.
 *
 * Classification keys on HTTP status and the gateway's numeric business codes
 * only. Free-text `msg` values never decide behaviour: the same wording can
 * describe an account-level and a request-level failure.
 *
 * @module dsh-native-tui/codebuddy/errors
 */

/** What went wrong, in DSH's terms rather than the gateway's. */
export type FailureKind =
  /** Credential rejected; refreshing once is safe, otherwise re-login. */
  | 'auth'
  /** Account out of credits; retrying cannot help. */
  | 'quota'
  /** Transient throttling; back off and retry. */
  | 'rate_limit'
  /** The model id is gone upstream; refresh the catalogue. */
  | 'no_such_model'
  /** This request is malformed for the gateway; another account will not help. */
  | 'bad_request'
  /** Upstream unavailable or a gateway fault; retry can help. */
  | 'unavailable'
  /** Network-level failure (DNS, TLS, timeout before headers). */
  | 'transport'
  /** Stream ended without a terminal frame. Never report as success. */
  | 'incomplete_stream'
  | 'unknown'

/**
 * Gateway business codes with an agreed meaning.
 *
 * Codes not listed here stay `unknown` on purpose — a wrong guess misattributes
 * a real outage to the request. 11140 is absent deliberately: the reference
 * measured it as account-level risk control arriving with HTTP 403, so it falls
 * through to the 403 status rule.
 */
const GATEWAY_CODES: Readonly<Record<number, FailureKind>> = {
  11102: 'no_such_model',
  11103: 'bad_request',
  11128: 'bad_request',
  11133: 'bad_request',
  11134: 'rate_limit',
  11135: 'bad_request',
}

/**
 * Classify one gateway business code.
 * @param code - numeric business code, when the body carries one.
 * @returns its failure kind, or undefined for an unrecognized code.
 */
export function classifyGatewayCode(code: unknown): FailureKind | undefined {
  return typeof code === 'number' ? GATEWAY_CODES[code] : undefined
}

/**
 * Classify one HTTP status, letting a recognized business code win.
 * @param status - HTTP status.
 * @param businessCode - numeric business code from the body, when present.
 * @returns the failure kind.
 */
export function classifyHttpStatus(status: number, businessCode?: unknown): FailureKind {
  const byCode = classifyGatewayCode(businessCode)
  if (byCode !== undefined) return byCode
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if (status === 404 || status === 405) return 'unavailable'
  if (status === 408 || status === 409 || status === 425) return 'unavailable'
  if (status === 413 || status === 415 || status === 422) return 'bad_request'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'unavailable'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

/** The gateway's numeric business code, when the body carries one. */
export function gatewayCodeOf(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const code = (body as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/**
 * Parse an already-read response body, then run the status + code classification.
 * @param status - HTTP status.
 * @param body - response text.
 * @returns the failure kind.
 */
export function classifyFailure(status: number, body: string): FailureKind {
  let parsed: unknown
  try {
    parsed = body === '' ? undefined : JSON.parse(body)
  }
  catch {
    parsed = undefined
  }
  return classifyHttpStatus(status, gatewayCodeOf(parsed))
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '<jwt>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <redacted>'],
  [/("(?:access|refresh|accessToken|refreshToken|id_token|state)"\s*:\s*")[^"]{4,}(")/gi, '$1<redacted>$2'],
  [/\b(access_token|refresh_token|accessToken|refreshToken|state|code)=([^&\s"']{4,})/gi, '$1=<redacted>'],
]

/** The gateway's numeric code as it appears in a raw error body. */
function businessCodeIn(text: string): unknown {
  const match = /"code"\s*:\s*(-?\d+)/u.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * A next step for a failure the user can act on.
 *
 * Returns undefined for failures DSH already handles or explains — a hint that
 * repeats the error, or guesses at a cause, is worse than none.
 * @param errorMessage - rendered failure text, when there is one.
 * @returns the actionable hint, or undefined.
 */
export function hintForGatewayError(errorMessage: string | undefined): string | undefined {
  if (typeof errorMessage !== 'string' || errorMessage === '') return undefined
  if (businessCodeIn(errorMessage) === 11128) {
    return 'CodeBuddy refused this call as a non-official client (channel verification). Retrying will not help; the CN route already restates the harness identity line, so a new fingerprint may have been added upstream.'
  }
  switch (classifyGatewayCode(businessCodeIn(errorMessage))) {
    case 'no_such_model':
      return 'The gateway has withdrawn this model. Run /codebuddy models refresh, then pick another with /model.'
    case 'bad_request':
      return 'The gateway rejected this request shape, not the account. Retrying or switching accounts will not help; the request payload is what to look at.'
    default:
      break
  }
  if (/\b(401|403)\b/u.test(errorMessage) && /token|auth|session/i.test(errorMessage)) {
    return 'The stored credential was refused. Run /codebuddy login again if it does not recover on its own.'
  }
  return undefined
}

/**
 * Remove credential material from anything that may reach a log, an error
 * message, or a bug report.
 * @param text - text to sanitize.
 * @returns the sanitized text.
 */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}
