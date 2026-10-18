/**
 * Built-in CodeBuddy / WorkBuddy provider plugin for the terminal bundle.
 *
 * Mounted by the bundle patch as `dsh-native-tui/codebuddy`. It registers both
 * deployments as DSH LLM routes through one adapter and offers a browser OAuth
 * sign-in through the authorization seam, so the terminal profile reaches
 * CodeBuddy without the web router stack or a local proxy.
 *
 * @module dsh-native-tui/codebuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import { CodeBuddyAdapter, type ProfileStatus, type RefreshOutcome } from './codebuddy/adapter.js'
import { credentialKeyFor, login, type CredentialStoreLike, type LoginSession } from './codebuddy/auth.js'
import { PROFILES, type CodeBuddyProfile } from './codebuddy/profiles.js'

/** Cordis plugin name; also the credential-record scope this plugin owns. */
export const name = 'codebuddy'

/** The LLM seam is the only service required to register the routes. */
export const inject = ['llm']

/** The command and diagnostics surface the terminal reads from `host.get('codebuddy')`. */
export interface CodeBuddyService {
  /** Advertised state of both routes. */
  status(): readonly ProfileStatus[]
  /** Refresh one route, or both when no id is given. */
  refresh(profileId?: string): Promise<readonly RefreshOutcome[]>
  /** A request-ready access token for one route. */
  accessTokenFor(profileId: string, signal?: AbortSignal): Promise<string>
  /** Delete the stored grant for one route. */
  logout(profileId: string): Promise<void>
  /** Credential-record key an authorization surface begins a sign-in for. */
  credentialKey(profileId: string): string
}

/** One authorization flow, as the seam's registry accepts it. */
interface AuthorizationFlowLike {
  readonly key: string
  readonly label: string
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  run(session: {
    readonly method: string
    readonly signal: AbortSignal
    notify(notice: { message: string; url?: string; code?: string }): void
    commit(record: { kind: 'grant'; payload: unknown }): Promise<void>
    prompt(prompt: unknown): Promise<string>
  }): Promise<void>
}

/** The authorization-service slice this plugin registers into. */
interface AuthorizationLike {
  registerFlow(flow: AuthorizationFlowLike): () => void
}

/** Register one browser sign-in flow per deployment. */
function registerFlows(authorization: AuthorizationLike, profiles: readonly CodeBuddyProfile[]): void {
  for (const profile of profiles) {
    try {
      authorization.registerFlow({
        key: credentialKeyFor(profile),
        label: profile.name,
        methods: [{ id: 'oauth', label: 'Sign in with browser' }],
        run: async session => { await login(profile, session as LoginSession) },
      })
    }
    catch (error) {
      // A duplicate key means another family already claims this record; the
      // routes stay mounted and that surface owns the sign-in instead.
      globalThis.console.warn('codebuddy: sign-in flow not registered for ' + profile.id + ': ' + String(error))
    }
  }
}

/**
 * Mount both CodeBuddy routes, their sign-in flows and the terminal-facing
 * service.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const adapter = new CodeBuddyAdapter({
    store: () => ctx.get('credentials') as CredentialStoreLike | undefined,
    onDiagnostic: message => ctx.logger?.warn?.(message),
  })
  ctx.llm.registerAdapter(PROFILES.map(profile => profile.id), adapter)
  const withdraw = (ctx as unknown as { provide(name: string, value: unknown): () => void })
    .provide('codebuddy', adapter as CodeBuddyService)
  ctx.effect(() => () => { withdraw() })

  // Signing in is what makes these routes worth selecting, so the flows are
  // offered whether or not anything is configured yet; a composition without
  // the seam simply has no surface to sign in from.
  ctx.inject(['authorization'], (authorized) => {
    registerFlows((authorized as unknown as { authorization: AuthorizationLike }).authorization, PROFILES)
  })
  ctx.logger?.info?.('codebuddy: registered routes ' + PROFILES.map(profile => profile.id).join(', '))
}
