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
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name: string; readonly description?: string }[]>
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
    secrets?: readonly { path: readonly string[]; set: boolean }[]
  }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[], expectedRevision?: number): Promise<void>
}

/** The permission-preset service. */
export interface PermissionPresets {
  readonly names: readonly string[]
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

/** The subagent service. */
export interface SubagentsService {
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentRow[]>
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

/** One reminder row. */
export interface ScheduleRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
}

/** The schedule service. */
export interface ScheduleService {
  list(request: { sessionId: SessionId }): Promise<readonly ScheduleRow[]>
  create(
    sessionId: SessionId,
    request: { title: string; prompt: string; after_seconds: number },
    signal?: AbortSignal,
  ): Promise<ScheduleRow>
  delete(request: { sessionId: SessionId; id: string }, signal?: AbortSignal): Promise<unknown>
}

/** One plugin entry. */
export interface PluginRow {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly readOnlyReason?: string
  readonly meta?: { readonly name?: string; readonly description?: string }
}

/** The outcome of one plugin enable/install/remove. */
export interface PluginChangeResult {
  readonly changed: boolean
  readonly application: string
  readonly target: string
  readonly enabled?: boolean
  readonly error?: { readonly code: string; readonly message?: string }
}

/** The result of inspecting an installable plugin spec. */
export interface PluginInspection {
  readonly status: 'accepted' | 'refused'
  readonly kind?: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly bundle?: boolean | null
  readonly problem?: string
  readonly reason?: string
}

/** The plugin manager the `/plugins` handler drives. */
export interface PluginManagerService {
  listBundles(): Promise<readonly {
    name: string
    enabled: boolean
    installed: boolean
    removable?: boolean
    official?: boolean
    availability?: string
    optional?: boolean
    version?: string
    description?: string
    installTarget?: { readonly spec: string; readonly version: string }
  }[]>
  listPlugins(): Promise<readonly PluginRow[]>
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeResult>
  inspect(spec: string): Promise<PluginInspection>
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<PluginChangeResult>
  removeBundle(name: string): Promise<PluginChangeResult>
}

/** The workspace-changes service behind `/changes` and `/diff`. */
export interface WorkspaceChangesService {
  summary(sessionId: SessionId, seq: number): import('../../runtime/changes.js').ChangesSummaryView | undefined
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<import('../../runtime/changes.js').WorkspaceDiffView | undefined>
}

/** The MCP manager's live connection snapshot. */
export interface McpManagerStatus {
  snapshot(): Record<string, { readonly status: 'starting' | 'connected' | 'disconnected' | 'error'; readonly error?: string }>
}

/** Per-session projection reads. */
export interface SessionProjectionsService {
  stateOf(session: Session, key: string): unknown
}

/** Persists the model the user picked for a session. */
export interface AgentDefaultModelService {
  saveSelection(selection: ModelSelection): Promise<void>
}

/** The credential store the provider handler writes through. */
export interface CredentialsService {
  set(ref: string, value: string): Promise<void>
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>
}

/** The agent-preset registry. */
export interface AgentPresetsService {
  list(): Promise<readonly { readonly id: string; readonly title?: string; readonly description?: string }[]>
  composedPreset(ctx: unknown): string | undefined
  select(agent: unknown, id: string): Promise<string>
  readonly defaultId?: string
}

/** User-invocable skills, for the `/help` footer. */
export interface SkillsCatalog {
  list(options?: { readonly cwd?: string; readonly signal?: AbortSignal; readonly scope?: unknown }): Promise<readonly {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }
  }[]>
}
