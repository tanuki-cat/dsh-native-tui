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

import { LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { accessToken, logout, readGrant, type CredentialStoreLike } from './auth.js'
import { discoverModels, seedCatalogue, TEXT_ONLY, type CatalogueModel, type InputModality } from './models.js'
import { DEFAULT_CONTEXT_WINDOW, PROFILES, getProfile, type CodeBuddyProfile } from './profiles.js'
import { buildChatPayload, imageTargetOf, type WireImageReader } from './wire.js'
import { streamChat } from './stream.js'

/** Catalogue freshness window: a picker open after this refreshes once. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000

/** Ceiling for one lazy catalogue refresh. */
const CATALOGUE_TIMEOUT_MS = 15_000

/** Host retry defaults, read once so the policy below can extend their code set. */
const HOST_RETRY_DEFAULTS = resolveRetryPolicy(undefined, 'codebuddy retryPolicy')

/**
 * Retry policy for both CodeBuddy routes: the host defaults plus
 * `INCOMPLETE_STREAM`, raised when the gateway closed a stream without a finish
 * frame. That completion cannot be resumed, so replaying the request is the
 * only way to recover it.
 */
const RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy({
  mode: 'normal',
  retryableCodes: [
    // Omission of config always resolves to a normal policy, so this guard only
    // narrows the union for the compiler; it never drops a code in practice.
    ...(HOST_RETRY_DEFAULTS.mode === 'normal' ? HOST_RETRY_DEFAULTS.retryableCodes : []),
    'INCOMPLETE_STREAM',
  ],
}, 'codebuddy retryPolicy')

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

/** Where one model's declared modalities came from. */
export type ModalitySource = 'catalogue' | 'override' | 'seed'

/**
 * Why a declaration the route wanted was narrowed before the harness read it.
 *
 * The only narrowing this route performs is the attachment fallback: a model
 * declared with images by the catalogue or by an operator override is still
 * declared text-only when this composition cannot produce image bytes. Naming
 * the cause is what lets a reader tell a working override from an inactive one.
 */
export type ModalityDegradation = 'no-attachment-service'

/** One model as the /codebuddy models surface reports it. */
export interface ModelSummary {
  readonly id: string
  /** What the harness gate will read for this model right now. */
  readonly inputModalities: readonly InputModality[]
  /** What the catalogue states, before any override or attachment fallback. */
  readonly statedModalities: readonly InputModality[]
  /** The declaration in force before the attachment fallback, override included. */
  readonly declaredModalities: readonly InputModality[]
  readonly source: ModalitySource
  /** Set when {@link declaredModalities} asked for images this composition cannot send. */
  readonly degraded?: ModalityDegradation
}

/** One image the harness hands an adapter: normalized bytes plus display size. */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** Attachment capability this adapter reads request-size images from. */
export interface AttachmentImageService {
  readImageRequest(
    ref: ImageRef,
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string }>
}

/** One operator claim about a model the catalogue cannot answer for. */
export interface ModelOverride {
  /** Modalities to declare instead of the catalogue's. */
  readonly input?: readonly InputModality[]
}

/** Constructor dependencies of {@link CodeBuddyAdapter}. */
export interface CodeBuddyAdapterOptions {
  /** The credential seam, or undefined in a composition without one. */
  store: () => CredentialStoreLike | undefined
  /** Host projection for durable file references, when the runtime offers one. */
  resolveFileText?: (ref: unknown) => string
  /**
   * Attachment service, when this composition mounts one. Without it an image
   * cannot be turned into bytes, so every model stays text-only regardless of
   * what the catalogue states.
   */
  resolveAttachments?: () => AttachmentImageService | undefined
  /**
   * Per-model modality overrides, keyed by model id. The catalogue decides by
   * default; this exists for the models it describes conservatively — measured
   * 2026-10-19, `default` and `glm-5.0` declare no images and still read them.
   */
  models?: Readonly<Record<string, ModelOverride>>
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

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const profile = this.profileOf(provider)
      const state = this.stateOf(profile)
      await this.refreshCatalogue(profile, state, false)
      // One capability lookup per listing, not one per model.
      const imageService = this.attachmentService() !== undefined
      return state.models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: this.modalitiesOf(model, imageService),
      }))
    })
  }

  /**
   * The attachment service, or undefined when this composition cannot send
   * image bytes.
   *
   * The host resolves a missing service to undefined; a resolver that throws
   * is a broken composition, not an image capability, so it reads as "no
   * service" instead of failing every model listing or the turn that hit it.
   * @returns the service, or undefined.
   */
  private attachmentService(): AttachmentImageService | undefined {
    try {
      return this.config.resolveAttachments?.()
    }
    catch (error) {
      this.config.onDiagnostic?.('attachment service unavailable: '
        + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /**
   * The operator's modality claim for one model, when there is one.
   *
   * The schema fills a written but empty `input` with `[]`; a model that
   * accepts nothing is neither a state this route can send nor one an operator
   * could have meant, so an empty list is treated as no claim at all.
   * @param modelId - catalogue model id.
   * @returns the declared modalities, or undefined.
   */
  private overrideOf(modelId: string): readonly InputModality[] | undefined {
    const input = this.config.models?.[modelId]?.input
    return input !== undefined && input.length > 0 ? input : undefined
  }

  /**
   * The modalities this route wants for one catalogue entry, before any
   * composition limit applies. An override wins when it states something;
   * otherwise the catalogue answers.
   * @param model - catalogue entry.
   * @returns the declared modalities.
   */
  private declaredModalitiesOf(model: CatalogueModel): readonly InputModality[] {
    return this.overrideOf(model.id) ?? model.inputModalities
  }

  /**
   * Modalities to declare for one catalogue entry.
   *
   * A composition without an attachment service cannot produce image bytes at
   * all, so declaring images there would only fail the turn later. That the
   * narrowing happened is reported by {@link CodeBuddyAdapter.models}, not
   * swallowed here.
   * @param model - catalogue entry.
   * @param imageService - whether this composition can read image bytes.
   * @returns the modalities the harness gate reads.
   */
  private modalitiesOf(model: CatalogueModel, imageService: boolean): readonly InputModality[] {
    const declared = this.declaredModalitiesOf(model)
    if (!declared.includes('image')) return declared
    return imageService ? declared : TEXT_ONLY
  }

  /** The request-image projection this route actually sends. */
  override imageRequestTarget(_provider: string, _model: string, image: ImageRef): { width: number; height: number; maxBytes: number } {
    return imageTargetOf(image)
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(async () => {
      const profile = this.profileOf(provider)
      return this.modelInfo(profile, model, await this.catalogueOf(profile))
    })
  }

  /**
   * The route's catalogue, refreshed when stale.
   *
   * A capability lookup must not answer from the seed list: a seed is an id,
   * not a capability claim, so a cold route would report no reasoning levels
   * for a model that has them — and the host rejects the effort the session
   * had already selected with UNSUPPORTED_REASONING_EFFORT before the first
   * picker ever refreshed the catalogue. The refresh is the same TTL-bounded
   * one a listing performs, so a warm route costs no request.
   * @param profile - route to read.
   * @returns the models capability questions are answered from.
   */
  private async catalogueOf(profile: CodeBuddyProfile): Promise<readonly CatalogueModel[]> {
    const state = this.stateOf(profile)
    await this.refreshCatalogue(profile, state, false)
    return state.models
  }

  /** Exact model metadata, with a conservative fallback for an unlisted id. */
  private modelInfo(
    profile: CodeBuddyProfile,
    model: string,
    models: readonly CatalogueModel[],
  ): LlmResolvedModelInfo {
    const imageService = this.attachmentService() !== undefined
    const known = models.find(entry => entry.id === model)
    if (known === undefined) {
      // Core routing accepts unlisted model ids; a catalogue that is stale or
      // account-restricted must not make a hand-typed model unroutable. An
      // unlisted id carries no capability claim, so it stays text-only even
      // when an override names it — the model is not in the catalogue yet.
      return {
        provider: profile.id,
        id: model,
        name: model,
        inputModalities: TEXT_ONLY,
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
      inputModalities: this.modalitiesOf(known, imageService),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve().then(async () => {
      const profile = this.profileOf(provider)
      const info = this.modelInfo(profile, model, await this.catalogueOf(profile))
      return {
        model: info,
        stream: (options: GenerateOptions) => this.streamWithProfile(options, profile),
      }
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
    const attachments = this.attachmentService()
    const payload = await buildChatPayload(options, profile, this.config.resolveFileText, {
      ...(attachments === undefined ? {} : { reader: attachments as WireImageReader }),
      onDiagnostic: message => this.config.onDiagnostic?.(profile.id + ': ' + message),
    })
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

  /**
   * Every model of one route with the modalities it will actually declare.
   *
   * Reports the override and the attachment fallback separately from the
   * catalogue's own claim, because a model can say `image` and still be
   * declared text-only when this composition cannot read attachment bytes. An
   * operator override that is narrowed the same way is marked `degraded`, so
   * the surface can say the override is inactive instead of reporting it as
   * applied.
   * @param profileId - route to report.
   * @returns one entry per model, in catalogue order.
   */
  models(profileId: string): readonly ModelSummary[] {
    const state = this.stateOf(this.profileOf(profileId))
    const imageService = this.attachmentService() !== undefined
    return state.models.map((model) => {
      const declared = this.declaredModalitiesOf(model)
      const degraded = declared.includes('image') && !imageService
      return {
        id: model.id,
        inputModalities: this.modalitiesOf(model, imageService),
        statedModalities: model.inputModalities,
        declaredModalities: declared,
        source: this.overrideOf(model.id) !== undefined
          ? 'override'
          : state.lastRefresh === undefined ? 'seed' : 'catalogue',
        ...(degraded ? { degraded: 'no-attachment-service' as const } : {}),
      }
    })
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
