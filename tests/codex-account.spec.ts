import { describe, expect, it } from 'vitest'
import { credentialState, grantOf, readCodexAccount } from '../src/codex/account.js'
import type { CredentialRecordLike } from '../src/codex/types.js'

/** Encode one JWT with the given claims; the signature is irrelevant here. */
function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return encode({ alg: 'none' }) + '.' + encode(claims) + '.signature'
}

const NOW = 1_700_000_000_000

/** A stored grant with the given payload overrides. */
function record(payload: Record<string, unknown>): CredentialRecordLike {
  return { kind: 'grant', payload }
}

describe('Codex credential account', () => {
  it('returns undefined for another record kind', () => {
    expect(grantOf({ kind: 'api-key', payload: {} })).toBeUndefined()
    expect(grantOf(undefined)).toBeUndefined()
  })

  it('classifies a missing record as absent', () => {
    expect(credentialState(undefined, NOW)).toEqual({ kind: 'absent' })
  })

  it('classifies a grant without access or expiry as incomplete', () => {
    expect(credentialState(record({ refresh: 'r' }), NOW)).toEqual({ kind: 'incomplete' })
    expect(credentialState(record({ access: 'a', expires: 'soon' }), NOW)).toEqual({ kind: 'incomplete' })
  })

  it('classifies an unexpired grant as valid', () => {
    const state = credentialState(record({ access: 'a', refresh: 'r', expires: NOW + 1000 }), NOW)
    expect(state.kind).toBe('valid')
  })

  it('separates refreshable and unrefreshable expiry', () => {
    expect(credentialState(record({ access: 'a', refresh: 'r', expires: NOW }), NOW).kind).toBe('expired-refreshable')
    expect(credentialState(record({ access: 'a', expires: NOW }), NOW).kind).toBe('expired')
  })

  it('decodes name, plan and account id without exposing the token', () => {
    const access = token({
      'https://api.openai.com/profile': { name: 'Ada', email: 'ada@example.com' },
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' },
    })
    const account = readCodexAccount({ access, expires: NOW })
    expect(account).toMatchObject({ name: 'Ada', plan: 'plus', accountId: 'acct-1' })
    expect(JSON.stringify(account)).not.toContain(access)
  })

  it('prefers the stored account id and degrades on a malformed token', () => {
    const account = readCodexAccount({ access: 'not-a-jwt', accountId: 'stored', expires: NOW })
    expect(account?.accountId).toBe('stored')
    expect(readCodexAccount({})).toBeUndefined()
  })
})
