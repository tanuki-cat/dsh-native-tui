/**
 * DSH LLM adapter for the two CodeBuddy deployments.
 *
 * One adapter instance owns both routes; their profile tables are static, so
 * every operation reads the same facts and only the model catalogue is mutable
 * state. The credential is resolved (and rotated) per stream call, so a
 * sign-in or a rotation reaches the next request without a restart.
 *
 * @module dsh-native-tui/codebuddy/adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { accessToken, logout, readGrant, type CredentialStoreLike } from './auth.js'
import { discoverModels, seedCatalogue, type CatalogueModel } from './models.js'
import { DEFAULT_CONTEXT_WINDOW, PROFILES, getProfile, type CodeBuddyProfile } from './profiles.js'
import { buildChatPayload } from './wire.js'
import { streamChat } from './stream.js'

/** Catalogue freshness window: a picker open after this refreshes once. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000

/** Ceiling for one lazy catalogue refresh. */
const CATALOGUE_TIMEOUT_MS = 15_000

/** Mutable per-route state: the catalogue and the last refresh outcome. */
interface ProfileState {
  models: CatalogueModel[]
  lastRefresh?: number
  lastError?: string
  refreshing?: Promise<void>
}

/** One route's advertised state, for the /codebuddy status surface. */
export interface ProfileStatus {
  readonly id: string
  readonly name: string
  readonly modelCount: number
  readonly lastRefresh?: number
  readonly lastError?: string
}

/** One catalogue refresh outcome. */
export interface RefreshOutcome {
  readonly id: string
  readonly error?: string
}

/** Constructor dependencies of {@link CodeBuddyAdapter}. */
export interface CodeBuddyAdapterOptions {
  /** The credential seam, or undefined in a composition without one. */
  store: () => CredentialStoreLike | undefined
  /** Host projection for durable file references, when the runtime offers one. */
  resolveFileText?: (ref: unknown) => string
  /** Observe a contained catalogue or credential failure. */
  onDiagnostic?: (message: string) => void
}

/** The credential seam, or the failure that names what is missing. */
function requireStore(store: CredentialStoreLike | undefined): CredentialStoreLike {
  if (store === undefined) {
    throw new LlmError(
      'codebuddy: this composition mounts no credentials service, so there is nowhere to store or read a'
      + ' CodeBuddy sign-in; mount one (dsh-credentials-local) to use these routes',
      'NO_CREDENTIAL_STORE',
    )
  }
  return store
}

/**
 * Both CodeBuddy routes as one harness adapter.
 */
export class CodeBuddyAdapter extends LlmAdapter {
  private readonly states = new Map<string, ProfileState>()

  constructor(private readonly config: CodeBuddyAdapterOptions) {
    super()
    for (const profile of PROFILES) {
      this.states.set(profile.id, { models: seedCatalogue(profile) })
    }
  }

  /** The profile for one route, or the not-owned failure. */
  private profileOf(provider: string): CodeBuddyProfile {
    const profile = getProfile(provider)
    if (profile === undefined) throw new LlmError('codebuddy adapter does not own provider "' + provider + '"', 'NO_ADAPTER')
    return profile
  }

  /** The mutable state for one route. */
  private stateOf(profile: CodeBuddyProfile): ProfileState {
    const state = this.states.get(profile.id)
    if (state === undefined) throw new LlmError('codebuddy adapter has no state for "' + profile.id + '"', 'NO_ADAPTER')
    return state
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.profileOf(provider).name }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const profile = this.profileOf(provider)
      const state = this.stateOf(profile)
      await this.refreshCatalogue(profile, state, false)
      return state.models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text'] as const,
      }))
    })
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const profile = this.profileOf(provider)
      return this.modelInfo(profile, model)
    })
  }

  /** Exact model metadata, with a conservative fallback for an unlisted id. */
  private modelInfo(profile: CodeBuddyProfile, model: string): LlmResolvedModelInfo {
    const known = this.stateOf(profile).models.find(entry => entry.id === model)
    if (known === undefined) {
      // Core routing accepts unlisted model ids; a catalogue that is stale or
      // account-restricted must not make a hand-typed model unroutable.
      return {
        provider: profile.id,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      }
    }
    const efforts: { id: ReturnType<typeof ReasoningEffortId>; name: string }[] = []
    if (known.canDisableThinking !== false) efforts.push({ id: ReasoningEffortId('off'), name: 'Off' })
    for (const effort of known.reasoningEfforts ?? []) {
      if (effort === 'off') continue
      efforts.push({ id: ReasoningEffortId(effort), name: effort.charAt(0).toUpperCase() + effort.slice(1) })
    }
    return {
      provider: profile.id,
      id: known.id,
      name: known.name,
      inputModalities: ['text'],
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const profile = this.profileOf(provider)
    const info = this.modelInfo(profile, model)
    return Promise.resolve({
      model: info,
      stream: options => this.streamWithProfile(options, profile),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithProfile(options, this.profileOf(options.provider))
  }

  /** Resolve the credential, build the body and stream one call. */
  private async * streamWithProfile(options: GenerateOptions, profile: CodeBuddyProfile): AsyncGenerator<StreamChunk> {
    const store = requireStore(this.config.store())
    const signal = options.signal
    const access = await accessToken(store, profile, signal)
    const payload = buildChatPayload(options, profile, this.config.resolveFileText)
    yield* streamChat({
      profile,
      model: options.model,
      payload,
      access,
      ...(signal === undefined ? {} : { signal }),
      // One controlled replay: the first 401/403 rotates the grant and retries.
      reauthorize: () => accessToken(store, profile, signal, true),
    })
  }

  /**
   * Ensure the catalogue is fresh, at most once per TTL.
   * @param profile - route to refresh.
   * @param state - the route's mutable state.
   * @param force - refresh even when the catalogue is still fresh.
   */
  private async refreshCatalogue(profile: CodeBuddyProfile, state: ProfileState, force: boolean): Promise<void> {
    const store = this.config.store()
    if (store === undefined) return
    if (!force && state.lastRefresh !== undefined && Date.now() - state.lastRefresh < CATALOGUE_TTL_MS) return
    if (state.refreshing !== undefined) {
      await state.refreshing
      return
    }
    const attempt = (async () => {
      try {
        const grant = await readGrant(store, profile)
        if (grant === undefined) {
          state.lastError = 'not signed in'
          return
        }
        const result = await discoverModels(profile, grant.access, AbortSignal.timeout(CATALOGUE_TIMEOUT_MS))
        if (result.error !== undefined) {
          state.lastError = result.error
          this.config.onDiagnostic?.(profile.id + ': catalogue refresh failed: ' + result.error)
          return
        }
        state.models = result.models
        state.lastRefresh = Date.now()
        state.lastError = undefined
      }
      catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
        this.config.onDiagnostic?.(profile.id + ': catalogue refresh failed: ' + state.lastError)
      }
    })()
    state.refreshing = attempt
    try {
      await attempt
    }
    finally {
      state.refreshing = undefined
    }
  }

  /** Advertised state of both routes, for /codebuddy status. */
  status(): readonly ProfileStatus[] {
    return PROFILES.map((profile) => {
      const state = this.stateOf(profile)
      return {
        id: profile.id,
        name: profile.name,
        modelCount: state.models.length,
        ...(state.lastRefresh === undefined ? {} : { lastRefresh: state.lastRefresh }),
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      }
    })
  }

  /**
   * Refresh one route, or both when no id is given.
   * @param profileId - route to refresh.
   * @returns one outcome per attempted route.
   */
  async refresh(profileId?: string): Promise<readonly RefreshOutcome[]> {
    const selected = profileId === undefined ? PROFILES : [this.profileOf(profileId)]
    const outcomes: RefreshOutcome[] = []
    for (const profile of selected) {
      const state = this.stateOf(profile)
      await this.refreshCatalogue(profile, state, true)
      outcomes.push({ id: profile.id, ...(state.lastError === undefined ? {} : { error: state.lastError }) })
    }
    return outcomes
  }

  /**
   * A request-ready access token for one route (rotated when due).
   * @param profileId - route to authenticate.
   * @param signal - cancellation for a rotation.
   * @returns the bearer token.
   */
  async accessTokenFor(profileId: string, signal?: AbortSignal): Promise<string> {
    const profile = this.profileOf(profileId)
    return accessToken(requireStore(this.config.store()), profile, signal)
  }

  /**
   * Delete the stored grant for one route.
   * @param profileId - route to sign out of.
   */
  async logout(profileId: string): Promise<void> {
    await logout(requireStore(this.config.store()), this.profileOf(profileId))
  }

  /**
   * The credential-record key an authorization surface must begin a sign-in for.
   * @param profileId - route to authorize.
   * @returns the record key.
   */
  credentialKey(profileId: string): string {
    return 'codebuddy/' + this.profileOf(profileId).id
  }
}
