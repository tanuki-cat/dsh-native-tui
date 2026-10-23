/**
 * Structural contracts for the TUI's Codex sign-in and route setup.
 *
 * The Host services are reached through `ctx.host.get(...)`, so these are
 * local slices rather than imports from the Host packages: the plugin depends
 * only on the members it calls, and a Host upgrade that adds fields stays
 * compatible.
 *
 * @module dsh-native-tui/codex/types
 */

/** pi-ai provider id for the ChatGPT Codex route. */
export const CODEX_PROVIDER = 'openai-codex'

/** Credential record key; must equal `credentialKey('llm-pi-ai', CODEX_PROVIDER)`. */
export const CODEX_KEY = 'llm-pi-ai/openai-codex'

/** Tone of one transcript notice. */
export type NoticeTone = 'info' | 'warning' | 'error'

/** One row of a keyboard-selected list. */
export interface CommandChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** One sign-in method a flow offers. */
export interface AuthorizationMethod {
  readonly id: string
  readonly label: string
}

/** What a running flow reports to the surface that started it. */
export interface AuthorizationNotice {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

/** One option of a `select` prompt. */
export interface AuthorizationPromptOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** A question the flow needs answered before it can continue. */
export type AuthorizationPrompt =
  | {
    readonly signal?: AbortSignal
    readonly kind: 'text' | 'secret'
    readonly message: string
    readonly placeholder?: string
  }
  | {
    readonly signal?: AbortSignal
    readonly kind: 'select'
    readonly message: string
    readonly options: readonly AuthorizationPromptOption[]
  }

/** A registered flow as a surface sees it. */
export interface AuthorizationEntry {
  readonly inFlight: boolean
  readonly methods: readonly AuthorizationMethod[]
}

/** One request to authorize a credential key. */
export interface AuthorizationBeginRequest {
  readonly key: string
  readonly method?: string
  readonly interaction: {
    notify(notice: AuthorizationNotice): void
    prompt(prompt: AuthorizationPrompt): Promise<string>
  }
  readonly signal?: AbortSignal
}

/** The authorization seam slice this feature drives. */
export interface AuthorizationLike {
  describe(key: string): AuthorizationEntry | undefined
  begin(request: AuthorizationBeginRequest): Promise<{ readonly status: 'authorized' | 'cancelled' }>
  cancel(key: string): void
}

/** One stored credential record, as the seam carries it. */
export interface CredentialRecordLike {
  readonly kind: string
  readonly payload?: unknown
}

/** The credential seam slice this feature reads and deletes. */
export interface CredentialStoreLike {
  readRecord(key: string): Promise<CredentialRecordLike | undefined>
  deleteRecord(key: string): Promise<void>
}

/** The OAuth grant pi-ai stores for the Codex route. */
export interface CodexGrant {
  readonly type?: 'oauth'
  readonly access?: string
  readonly refresh?: string
  readonly expires?: number
  readonly accountId?: string
}

/** What the stored record can currently be used for. */
export type CredentialState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'expired-refreshable'; readonly grant: CodexGrant }
  | { readonly kind: 'expired'; readonly grant: CodexGrant }
  | { readonly kind: 'valid'; readonly grant: CodexGrant }

/** Display facts decoded from the access token. Never carries the token itself. */
export interface CodexAccount {
  readonly name?: string
  readonly email?: string
  readonly plan?: string
  readonly accountId?: string
  readonly expires?: number
}

/** The LLM catalogue slice route setup reads. */
export interface ModelCatalog {
  listProviders(): readonly { readonly id: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name: string }[]>
}
