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

import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { resolveVolatileValue } from './config.js'
import {
  CodeBuddyAdapter,
  type AttachmentImageService,
  type ModelOverride,
  type ModelSummary,
  type ProfileStatus,
  type RefreshOutcome,
} from './codebuddy/adapter.js'
import { credentialKeyFor, login, type CredentialStoreLike, type LoginSession } from './codebuddy/auth.js'
import { PROFILES, type CodeBuddyProfile } from './codebuddy/profiles.js'

/** Cordis plugin name; also the credential-record scope this plugin owns. */
export const name = 'codebuddy'

/** The LLM seam is the only service required to register the routes. */
export const inject = ['llm']

/** Plugin configuration. */
export interface Config {
  /**
   * Per-model modality overrides for models the catalogue describes
   * conservatively. Measured 2026-10-19: `default` and `glm-5.0` declare no
   * image input and still read one.
   */
  models?: Record<string, ModelOverride>
  /**
   * System prompt template sent to both deployments.
   *
   * The gateway fingerprints the harness-composed prompt, so an operator needs
   * a way to change what it says without rebuilding the plugin. `{prompt}`
   * expands to that composed prompt — workspace rules, skills and tool notes
   * included — so a custom opening line can keep the rest; without the
   * placeholder the template replaces the prompt verbatim. Empty keeps the
   * default (CN identity restated, everything else untouched).
   *
   * Volatile so `/codebuddy prompt` can rewrite it through the Host settings
   * service and the next request reads the new value without a restart.
   *
   * Scoped to the two routes this adapter registers: the template is applied in
   * the CodeBuddy wire layer, so no other provider's request can carry it.
   */
  systemPrompt?: string | Volatile<string>
}

/**
 * Loader schema for the codebuddy row.
 *
 * `input` is optional because the map itself is optional: an entry may exist
 * only to be filled in later. A written but empty list is repaired to the
 * catalogue's own claim instead of declaring a model that accepts nothing —
 * see `CodeBuddyAdapter.modalitiesOf`.
 */
export const Config = z.object({
  models: z.dict(z.object({
    input: z.array(z.union(['text', 'image'] as const)),
  })).default({}),
  systemPrompt: z.string().default('').volatile()
    .description('System prompt sent to CodeBuddy. {prompt} expands to the harness-composed prompt; without it the text replaces that prompt verbatim. Empty keeps the default.'),
}) as unknown as z<Config>

/** The command and diagnostics surface the terminal reads from `host.get('codebuddy')`. */
export interface CodeBuddyService {
  /** Advertised state of both routes. */
  status(): readonly ProfileStatus[]
  /** Refresh one route, or both when no id is given. */
  refresh(profileId?: string): Promise<readonly RefreshOutcome[]>
  /** Every model of one route with the modalities it declares. */
  models(profileId: string): readonly ModelSummary[]
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
 * @param config - per-model modality overrides from the Loader row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const adapter = new CodeBuddyAdapter({
    store: () => ctx.get('credentials') as CredentialStoreLike | undefined,
    // Images reach this adapter as bytes only through the attachment service;
    // a composition without it stays text-only and says so in the catalogue.
    resolveAttachments: () => ctx.get('attachments') as AttachmentImageService | undefined,
    ...(config.models === undefined ? {} : { models: config.models }),
    // Read the volatile reference per request so /codebuddy prompt applies
    // without remounting the plugin.
    systemPrompt: () => resolveVolatileValue(config.systemPrompt),
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
