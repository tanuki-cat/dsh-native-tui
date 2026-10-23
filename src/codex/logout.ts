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
 * Sign out of the Codex route.
 * @param deps - the authorization and credential seams.
 * @returns how the sign-out ended.
 */
export async function logoutCodex(deps: LogoutDeps): Promise<LogoutOutcome> {
  if (await deps.credentials.readRecord(CODEX_KEY) === undefined) return 'not-signed-in'
  deps.authorization.cancel(CODEX_KEY)
  const wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const attempts = Math.max(1, deps.attempts ?? 40)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deps.signal.aborted) return 'busy'
    if (deps.authorization.describe(CODEX_KEY)?.inFlight !== true) break
    if (attempt === attempts - 1) return 'busy'
    await wait(50)
  }
  await deps.credentials.deleteRecord(CODEX_KEY)
  return await deps.credentials.readRecord(CODEX_KEY) === undefined ? 'signed-out' : 'still-present'
}
