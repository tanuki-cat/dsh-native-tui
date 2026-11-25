/**
 * Remove the stored Codex grant after a sign-in attempt has settled.
 *
 * Pi-ai refreshes tokens through the credential seam, so a delete that races a
 * commit or a refresh can be overwritten. Cancel first, let the flow release
 * its key, then delete and read back.
 *
 * @module dsh-native-tui/codex/logout
 */

import { CODEX_KEY, type AuthorizationLike, type CredentialStoreLike } from './types.js'

/** How one sign-out ended. */
export type LogoutOutcome = 'signed-out' | 'not-signed-in' | 'busy' | 'still-present'

/** Everything sign-out needs from the Host. */
export interface LogoutDeps {
  readonly authorization: AuthorizationLike
  readonly credentials: CredentialStoreLike
  readonly signal: AbortSignal
  readonly wait?: (ms: number) => Promise<void>
  readonly attempts?: number
}

/**
 * Cancel a running sign-in and wait for it to release the credential key.
 *
 * Callers must run this before they read the stored record: a flow that is
 * still polling commits its grant when it finishes, which would resurrect a
 * credential the caller is about to delete.
 * @param deps - the authorization seam and wait bounds.
 * @returns true once no flow is in flight, false when it never settled.
 */
export async function settleCodexAuthorization(deps: LogoutDeps): Promise<boolean> {
  deps.authorization.cancel(CODEX_KEY)
  const wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const attempts = Math.max(1, deps.attempts ?? 40)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deps.signal.aborted) return false
    if (deps.authorization.describe(CODEX_KEY)?.inFlight !== true) return true
    if (attempt === attempts - 1) return false
    await wait(50)
  }
  return true
}

/**
 * Sign out of the Codex route.
 * @param deps - the authorization and credential seams.
 * @returns how the sign-out ended.
 */
export async function logoutCodex(deps: LogoutDeps): Promise<LogoutOutcome> {
  // Never decide from the stored record before stopping a live attempt: a login
  // in flight would commit after the delete below and leave the user signed in.
  if (!await settleCodexAuthorization(deps)) return 'busy'
  if (await deps.credentials.readRecord(CODEX_KEY) === undefined) return 'not-signed-in'
  await deps.credentials.deleteRecord(CODEX_KEY)
  return await deps.credentials.readRecord(CODEX_KEY) === undefined ? 'signed-out' : 'still-present'
}
