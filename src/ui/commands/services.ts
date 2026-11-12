/**
 * Structural views of the Host services the command handlers and the terminal
 * wiring read.
 *
 * These are local interfaces rather than imports from the Host packages: the
 * plugin reaches services through `ctx.get(name)` and only depends on the slice
 * it actually calls.
 *
 * @module dsh-native-tui/ui/commands/services
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SkillSummaryLike } from '../../runtime/skill-catalog.js'

/** The LLM catalogue the model and provider handlers read. */
export interface LLM {
  listProviders(): readonly { readonly id: string; readonly name?: string }[]
  listConfigurableProviders(): readonly {
    readonly provider: string
    readonly displayName?: string
    readonly settingsNs?: string
    readonly nativeAuth?: { readonly env?: readonly string[]; readonly oauth?: boolean }
    readonly defaultBaseURL?: string
    readonly baseURLEnv?: readonly string[]
    readonly declared?: boolean
  }[]
  listModels(provider: string): Promise<readonly Pick<LlmModelInfo, 'id' | 'name' | 'description' | 'badge'>[]>
  discoverModels(settingsNs: string, request: {
    readonly provider?: string
    readonly baseURL?: string
    readonly api?: string
    readonly apiKey?: string
  }, signal?: AbortSignal): Promise<readonly {
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxTokens?: number
    readonly inputModalities?: readonly ('text' | 'image')[]
  }[]>
  resolveModelInfo(provider: string, model: string): Promise<{
    readonly context?: { readonly contextWindow?: number }
    readonly defaultMaxTokens?: number
    /** What the routed adapter declares the model accepts; absent when it claims nothing. */
    readonly inputModalities?: readonly ('text' | 'image')[]
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }>
}

/** The settings service, narrowed to the calls the handlers make. */
export interface SettingsService {
  describe(options?: { redactSecrets?: boolean }): readonly {
    ns: string
    value: Record<string, unknown>
    /** The profile patch's own section, used to address array indexes without restating them. */
    user?: unknown
    schema: unknown
    revision: number
    /** Whether the Host may generate a generic page for this namespace. */
    autoGenerate: boolean
    /** When the owner applies the edit; live is the only value the Host reports. */
    applies: 'live'
    secrets?: readonly { path: readonly string[]; set: boolean }[]
  }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[], expectedRevision?: number): Promise<void>
}

/** The permission-preset service. */
export interface PermissionPresets {
  readonly names: readonly string[]
  resolve(name: string): { sandbox: string; approval: string }
  current(session: Session): string
  set(session: Session, name: string): void
}

/** One background job row. */
export interface JobRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly startedAt: number
}

/** The background-job service. */
export interface JobsService {
  list(caller?: SessionId): readonly JobRow[]
  kill(id: string, caller?: SessionId, reason?: string): 'requested' | 'already-finished'
}

/** One subagent row. */
export interface SubagentRow {
  readonly id: SessionId
  readonly createdAt: number
  readonly mode: string
  readonly label?: string
}

/** One recursive descendant row from the rc.2 `listDescendants` surface. */
export interface SubagentDescendantRow {
  readonly id: SessionId
  readonly kind: 'child' | 'diagnostic'
  readonly parentId: SessionId
  readonly depth: number
  readonly path?: string
  readonly mode?: string
  readonly label?: string
  readonly name?: string
  readonly activity?: 'running' | 'inactive'
  readonly hasChildren?: boolean
  readonly reason?: 'corrupt' | 'unsupported' | 'unavailable'
}

/**
 * The subagent service. rc.2 exposes recursive listing; profiles on an older
 * Host still expose direct children, so both are declared optional here.
 */
export interface SubagentsService {
  listDescendants?(rootSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentDescendantRow[]>
  listChildren?(parentSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentRow[]>
}

/** One workspace row. */
export interface WorkspaceRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** The workspace service. */
export interface WorkspaceService {
  list(): readonly WorkspaceRow[]
  create(path: string, title?: string): Promise<WorkspaceRow>
  get(id: string): WorkspaceRow | undefined
  resolveByPath(path: string): Promise<WorkspaceRow | undefined>
  pinSession(sessionId: SessionId): Promise<void>
  unpinSession(sessionId: SessionId): Promise<void>
  archiveSession(sessionId: SessionId, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/** One plugin entry. */
export interface PluginRow {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly readOnlyReason?: string
  readonly meta?: { readonly name?: string; readonly description?: string }
}

/** The native command surface follows the Host's versioned management types. */
export type PluginChangeResult = import('@deepseek-ai/dsh-plugin-manager').ChangeResult
export type PluginInspection = import('@deepseek-ai/dsh-plugin-manager').PluginSpecInspection
export type PluginManagerService = Pick<import('@deepseek-ai/dsh-plugin-manager').PluginManager,
  'listBundles' | 'listPlugins' | 'setPluginEnabled' | 'inspect' | 'installBundle' | 'removeBundle' | 'listVersions' | 'updateBundle' | 'cancelInstall'>


/** The workspace-changes service behind `/changes` and `/diff`. */
export interface WorkspaceChangesService {
  summary(sessionId: SessionId, seq: number): import('../../runtime/changes.js').ChangesSummaryView | undefined
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<import('../../runtime/changes.js').WorkspaceDiffView | undefined>
}

/** Runtime state of one server under the rc.2 core MCP manager. */
export interface McpManagedServerStatus {
  readonly state: 'disabled' | 'connected' | 'connecting' | 'reconnecting' | 'closed' | 'waiting-credentials' | 'failed'
  readonly reason?: string
  readonly lastError?: string
  readonly toolCount?: number
  readonly attempt?: number
  readonly maxAttempts?: number
  /** Cleanup facts retained by the core manager for a failed removal. */
  readonly result?: { readonly cleanupError?: string }
}

/** One server as the core manager lists it. */
export interface McpManagedServerView {
  readonly name: string
  readonly configured: boolean
  readonly status: McpManagedServerStatus
}

/** Stage-classified one-shot probe outcome. */
export interface McpProbeResultLike {
  readonly ok: boolean
  readonly stage?: string
  readonly message?: string
  readonly serverInfo?: { readonly name?: string; readonly version?: string }
  readonly toolNames?: readonly string[]
  readonly truncated?: boolean
  readonly durationMs?: number
  readonly cleanupError?: string
}

/** The rc.2 core MCP manager surface the TUI calls. */
export interface McpManagerService {
  list(): readonly McpManagedServerView[]
  restart(name: string): Promise<void>
  probe(name: string, options?: { readonly signal?: AbortSignal }): Promise<McpProbeResultLike>
}

/** Per-session projection reads. */
export interface SessionProjectionsService {
  onEventChanged(listener: (session: Session, changes: readonly { readonly key: string; readonly val: unknown }[], seq: number) => void): () => void
  snapshot(session: Session, keys?: readonly string[]): { readonly values: Readonly<Record<string, unknown>> }
}

/** Persists the model the user picked for a session. */
export interface AgentDefaultModelService {
  saveSelection(selection: ModelSelection): Promise<void>
}

/** The credential store the provider handler writes through. */
export interface CredentialsService {
  set(ref: string, value: string): Promise<void>
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>
  /** Configuration facts only; rc.2 adds a provider-masked preview. */
  describe?(ref: string): Promise<{ readonly configured?: boolean; readonly masked?: string } | undefined>
}

/** The agent-preset registry. */
export interface AgentPresetsService {
  list(): Promise<readonly { readonly id: string; readonly name?: string; readonly description?: string }[]>
  composedPreset(ctx: unknown): string | undefined
  select(agent: unknown, id: string): Promise<string>
  readonly defaultId?: string
}

/**
 * The skill registry: every skill the Host can offer, with the invocation
 * controls and discovery root each one advertises.
 *
 * The catalog is invocation-neutral by design, so the terminal decides what to
 * offer: the `/` menu keeps user-invocable entries, while `/skill` lists both
 * controls so what the model may call stays reviewable.
 */
export interface SkillsCatalog {
  list(options?: { readonly cwd?: string; readonly signal?: AbortSignal; readonly scope?: unknown }): Promise<readonly SkillSummaryLike[]>
  /** Load one skill body, or undefined when the name no longer resolves. */
  get?(name: string, options?: { readonly cwd?: string; readonly signal?: AbortSignal; readonly scope?: unknown }): Promise<{
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly path?: string
    readonly content: string
    readonly source?: string
    readonly provider?: string
  } | undefined>
}
