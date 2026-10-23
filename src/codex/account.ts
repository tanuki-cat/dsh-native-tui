/**
 * Read the stored Codex grant and the non-secret account facts it carries.
 *
 * The access token is a JWT whose claims name the plan and profile. Nothing
 * here is returned except those display facts; the token never leaves a local
 * variable.
 *
 * @module dsh-native-tui/codex/account
 */

import type { CodexAccount, CodexGrant, CredentialRecordLike, CredentialState } from './types.js'

/** Whether a value is a non-array object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The grant payload of one stored record, or undefined for another record kind. */
export function grantOf(record: CredentialRecordLike | undefined): CodexGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = objectOf(record.payload)
  return payload === undefined ? undefined : payload as CodexGrant
}

/**
 * Classify what the stored record can currently be used for.
 * @param record - the stored record, or undefined when nothing is stored.
 * @param now - current epoch ms.
 * @returns the credential state.
 */
export function credentialState(record: CredentialRecordLike | undefined, now = Date.now()): CredentialState {
  if (record === undefined) return { kind: 'absent' }
  const grant = grantOf(record)
  if (grant === undefined) return { kind: 'incomplete' }
  if (typeof grant.access !== 'string' || grant.access === ''
    || typeof grant.expires !== 'number' || !Number.isFinite(grant.expires)) {
    return { kind: 'incomplete' }
  }
  if (grant.expires <= now) {
    return typeof grant.refresh === 'string' && grant.refresh !== ''
      ? { kind: 'expired-refreshable', grant }
      : { kind: 'expired', grant }
  }
  return { kind: 'valid', grant }
}

/** Decode one base64url JWT segment, or undefined when it is not JSON. */
function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')))
  }
  catch {
    return undefined
  }
}

/** A string claim, or undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the non-secret account facts from an OAuth grant.
 * @param grant - the stored grant, when one exists.
 * @returns display facts, or undefined when the token carries none.
 */
export function readCodexAccount(grant: CodexGrant | undefined): CodexAccount | undefined {
  if (grant === undefined || typeof grant.access !== 'string') return undefined
  const parts = grant.access.split('.')
  const claims = parts.length === 3 ? decodeSegment(parts[1] ?? '') : undefined
  const profile = objectOf(claims?.['https://api.openai.com/profile'])
  const auth = objectOf(claims?.['https://api.openai.com/auth'])
  const accountId = stringOf(grant.accountId) ?? stringOf(auth?.chatgpt_account_id)
  const account: CodexAccount = {
    ...(stringOf(profile?.name) === undefined ? {} : { name: stringOf(profile?.name) }),
    ...(stringOf(profile?.email) === undefined ? {} : { email: stringOf(profile?.email) }),
    ...(stringOf(auth?.chatgpt_plan_type) === undefined ? {} : { plan: stringOf(auth?.chatgpt_plan_type) }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(typeof grant.expires === 'number' ? { expires: grant.expires } : {}),
  }
  return Object.keys(account).length === 0 ? undefined : account
}
