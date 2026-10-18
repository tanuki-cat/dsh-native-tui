import {
  Editor,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DisplayMode, ResolvedConfig } from '../config.js'
import { createHostSession, resumeHostSession, sessionAgentPreset, sessionModelSelection, type AgentPresetService, type HostSession } from '../runtime/agent.js'
import type { SessionStats } from '../runtime/metrics.js'
import { openUrlInBrowser } from '../runtime/open.js'
import { ownStoredSessions, selectListedSessions } from '../runtime/session-list.js'
import { INIT_AGENTS_PROMPT } from '../runtime/init-prompt.js'
import { runCodebuddyCommand, type CodeBuddyCommandDeps } from '../runtime/codebuddy-command.js'
import type { CodeBuddyService } from '../codebuddy.js'
import { formatChangesSummary, type ChangesSummaryView, type WorkspaceDiffView } from '../runtime/changes.js'
import { formatDeliverables, type PresentedFileView } from '../runtime/deliverables.js'
import { showApproval, showChoice, showQuestionBatch, showTextInput } from './dialogs.js'
import type { PendingAttachment } from '../runtime/attachments.js'
import { TuiAutocompleteProvider, type CommandSuggestion, type SessionReferenceService, type SkillSuggestion } from './autocomplete.js'
import { currentPreset, renderStatusRows } from './status-line.js'
import { createPalette, editorTheme, markdownTheme, type Palette } from './theme.js'
import { globalShortcut } from './keymap.js'
import { changesCommand, deliverablesCommand, filesCommand } from './commands/artifacts.js'
import { attachCommand, attachmentsCommand } from './commands/attachments.js'
import type { CommandContext } from './commands/context.js'
import { mcpCommand } from './commands/mcp.js'
import { modelCommand, reasoningCommand } from './commands/model.js'
import { pluginsCommand } from './commands/plugins.js'
import { providerCommand } from './commands/provider.js'
import { agentsCommand, jobsCommand, permissionsCommand } from './commands/runtime-status.js'
import { helpCommand, statusCommand } from './commands/session.js'
import { sessionsCommand } from './commands/sessions.js'
import { openTuiSettings, settingsCommand, showHostSettings } from './commands/settings.js'
import { diffCommand, toolCommand, toolsCommand } from './commands/tools.js'
import { exportCommand, openCommand, presetCommand, previewCommand } from './commands/workspace-files.js'
import { scheduleCommand, workspacesCommand } from './commands/workspace.js'
import { subscribeSessionEvents } from './session-events.js'
import { TranscriptRenderer, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import { Rule } from './rule.js'
import { diffLines } from './diff.js'

const HELP_LINES: readonly string[] = [
  '/help · /new · /init · /sessions · /resume [id] · /status · /clear',
  '/exit · /quit (or bare exit/quit)',
  '/cancel · /model [provider/model] · /reasoning [effort] · /provider [add|list|edit|models|remove <route>]',
  '/mcp [add|list|remove <name>]',
  '/permissions [preset]',
  '/jobs [kill <id>] · /agents · /preset [id]',
  '/plugins [list|market [q]|inspect <spec>|install <spec>|remove <bundle>|enable <id>|disable <id>] · /exit',
  '/workspaces [new|use|pin|unpin|archive|unarchive] · /schedule [add|delete]',
  '/schedule [add <seconds> <title>|delete <id>] · /plugins · /exit',
  '/settings [tui|host|edit <ns>|items <ns> <field>|set <ns> <json>] · /export [path|zip|html] · /open <path> · /preview <image>',
  '/files [path] · /changes [diff <index>] · /deliverables [panel|open|reveal <index>]',
  '/tools · /tool <index> · /diff [index] · /exit',
  '/attach <path>|paste|preview <i>|list|clear · /attachments · /exit',
  '/codebuddy [status|login|logout|models refresh|quota|checkin|doctor]',
  '@@<query> references another session · /exit',
]

/** Terminal application lifecycle. */
export interface TerminalApp {
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void
  setMaxEntries(maxEntries: number): void
  dispose(): Promise<void>
}

const MAX_NOTICES = 12
/** Sessions shown by one `/sessions` notice; the store can hold hundreds. */
const MAX_LISTED_SESSIONS = 12
const NL = String.fromCharCode(10)

const LOCAL_COMMANDS: readonly CommandSuggestion[] = [
  { name: 'help', description: 'show local and host commands' },
  { name: 'new', description: 'create a new session' },
  { name: 'init', description: 'create a project-level AGENTS.md contributor guide' },
  { name: 'sessions', description: 'list persisted sessions' },
  { name: 'resume', description: 'resume a session', input: { hint: 'session-id' } },
  { name: 'status', description: 'show session, model, and preset' },
  { name: 'clear', description: 'clear the terminal view only' },
  { name: 'cancel', description: 'cancel the running turn' },
  { name: 'model', description: 'select a model', input: { hint: 'provider/model' } },
  { name: 'reasoning', description: 'select the model reasoning effort', input: { hint: 'effort' } },
  { name: 'permissions', description: 'select a permission preset', input: { hint: 'preset' } },
  { name: 'preset', description: 'select the preset for the current or next session', input: { hint: 'id' } },
  { name: 'workspaces', description: 'list/create/use/pin/archive workspaces', subcommands: [
    { name: 'new', description: 'create a workspace session', hint: '<path>' },
    { name: 'use', description: 'switch to a workspace', hint: '<id|path>' },
    { name: 'pin', description: 'pin a workspace', hint: '<id>' },
    { name: 'unpin', description: 'unpin a workspace', hint: '<id>' },
    { name: 'archive', description: 'archive a workspace', hint: '<id>' },
    { name: 'unarchive', description: 'unarchive a workspace', hint: '<id>' },
  ] },
  { name: 'schedule', description: 'list/add/delete reminders', subcommands: [
    { name: 'add', description: 'add a one-shot reminder', hint: '<seconds> <title>' },
    { name: 'delete', description: 'delete a reminder', hint: '<id>' },
  ] },
  { name: 'jobs', description: 'list or kill background jobs' },
  { name: 'agents', description: 'list direct subagents' },
  { name: 'plugins', description: 'list, browse market, inspect/install/remove, or toggle plugin entries', input: { hint: '[list|market|inspect|install|remove|enable|disable]' }, subcommands: [
    { name: 'list', description: 'list installed plugin entries' },
    { name: 'market', description: 'browse the official market', hint: '[query]' },
    { name: 'inspect', description: 'inspect a bundle', hint: '<spec>' },
    { name: 'install', description: 'install a bundle', hint: '<spec>' },
    { name: 'remove', description: 'remove a bundle', hint: '<bundle>' },
    { name: 'enable', description: 'enable one entry', hint: '<entryId>' },
    { name: 'disable', description: 'disable one entry', hint: '<entryId>' },
  ] },
  { name: 'settings', description: 'TUI base settings wizard, or advanced host settings', input: { hint: '[tui|host|edit <ns>|items <ns> <field>|set <ns> <json>]' }, subcommands: [
    { name: 'tui', description: 'open the base TUI settings wizard' },
    { name: 'host', description: 'list advanced host settings namespaces' },
    { name: 'edit', description: 'edit a settings namespace', hint: '<ns>' },
    { name: 'items', description: 'edit an array item', hint: '<ns> <field>' },
    { name: 'set', description: 'merge JSON into a namespace', hint: '<ns> <json>' },
  ] },
  { name: 'mcp', description: 'configure MCP servers', input: { hint: '[add|list|remove <name>]' }, subcommands: [
    { name: 'add', description: 'add a stdio or HTTP MCP server' },
    { name: 'list', description: 'list configured MCP servers' },
    { name: 'remove', description: 'remove an MCP server', hint: '<name>' },
  ] },
  { name: 'codebuddy', description: 'CodeBuddy / WorkBuddy sign-in, models and credits', input: { hint: '[status|login|logout|models refresh|quota|checkin|doctor]' }, subcommands: [
    { name: 'status', description: 'sign-in state, token rotation, catalogue' },
    { name: 'login', description: 'open the browser sign-in', hint: '[cn|en|all]' },
    { name: 'logout', description: 'remove the stored credential', hint: '[cn|en|all]' },
    { name: 'models', description: 'force a catalogue refresh', hint: 'refresh [cn|en]' },
    { name: 'quota', description: 'remaining credits', hint: '[cn|en]' },
    { name: 'checkin', description: 'claim today credits', hint: '[cn|en]' },
    { name: 'doctor', description: 'endpoint and catalogue probe' },
  ] },
  { name: 'provider', description: 'guided third-party model provider setup', input: { hint: '[add|list|edit|models|remove <route>]' }, subcommands: [
    { name: 'add', description: 'guide a new provider route' },
    { name: 'list', description: 'list configured providers' },
    { name: 'edit', description: 'open a provider and fetch its models', hint: '[route]' },
    { name: 'models', description: 'refresh models for a provider route', hint: '<route>' },
    { name: 'remove', description: 'delete a provider route', hint: '<route>' },
  ] },
  { name: 'export', description: 'export JSONL, ZIP bundle, or static HTML', input: { hint: '[path|zip [path]|html [path]]' } },
  { name: 'open', description: 'preview text or Markdown; Markdown renders styled', input: { hint: '<path>' } },
  { name: 'preview', description: 'render a PNG/JPEG/GIF/WebP image', input: { hint: '<path>' } },
  { name: 'files', description: 'browse a directory and preview a file', input: { hint: '[path]' } },
  { name: 'changes', description: 'show the latest changed files or one file diff', input: { hint: '[diff <index>]' } },
  { name: 'deliverables', description: 'list, panel, open, or reveal files declared by the present tool', input: { hint: '[panel|open|reveal <index>]' } },
  { name: 'tools', description: 'list recent tool calls' },
  { name: 'tool', description: 'page one tool call and its result', input: { hint: 'index' } },
  { name: 'diff', description: 'page the latest or one indexed tool diff', input: { hint: '[index]' } },
  { name: 'attach', description: 'stage or preview a file, image, or clipboard image', input: { hint: '<path>|paste|preview <i>|list|clear' } },
  { name: 'attachments', description: 'open the staged attachment manager' },
  { name: 'exit', description: 'exit the terminal front door' },
  { name: 'quit', description: 'exit the terminal front door' },
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface LlmCatalog {
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
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }>
}

interface SkillsCatalog {
  list(options?: { readonly cwd?: string; readonly signal?: AbortSignal; readonly scope?: unknown }): Promise<readonly {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }
  }[]>
}

interface PermissionPresets {
  readonly names: readonly string[]
  current(session: Session): string
  set(session: Session, name: string): void
}

interface JobRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly startedAt: number
}

interface JobsService {
  list(caller?: SessionId): readonly JobRow[]
  kill(id: string, caller?: SessionId, reason?: string): 'requested' | 'already-finished'
}

interface SubagentRow {
  readonly id: SessionId
  readonly createdAt: number
  readonly mode: string
  readonly label?: string
}

interface SubagentsService {
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentRow[]>
}

interface WorkspaceRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

interface WorkspaceService {
  list(): readonly WorkspaceRow[]
  create(path: string, title?: string): Promise<WorkspaceRow>
  get(id: string): WorkspaceRow | undefined
  resolveByPath(path: string): Promise<WorkspaceRow | undefined>
  pinSession(sessionId: SessionId): Promise<void>
  unpinSession(sessionId: SessionId): Promise<void>
  archiveSession(sessionId: SessionId, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId: SessionId): Promise<void>
}

interface ScheduleRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
}

interface ScheduleService {
  list(request: { sessionId: SessionId }): Promise<readonly ScheduleRow[]>
  create(
    sessionId: SessionId,
    request: { title: string; prompt: string; after_seconds: number },
    signal?: AbortSignal,
  ): Promise<ScheduleRow>
  delete(request: { sessionId: SessionId; id: string }, signal?: AbortSignal): Promise<unknown>
}

interface PluginRow {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly readOnlyReason?: string
  readonly meta?: { readonly name?: string; readonly description?: string }
}

interface PluginChangeResult {
  readonly changed: boolean
  readonly application: string
  readonly target: string
  readonly enabled?: boolean
  readonly error?: { readonly code: string; readonly message?: string }
}

interface PluginInspection {
  readonly status: 'accepted' | 'refused'
  readonly kind?: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly bundle?: boolean | null
  readonly problem?: string
  readonly reason?: string
}

interface PluginManagerService {
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

interface WorkspaceChangesService {
  summary(sessionId: SessionId, seq: number): ChangesSummaryView | undefined
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceDiffView | undefined>
}

interface McpManagerStatus {
  snapshot(): Record<string, { readonly status: 'starting' | 'connected' | 'disconnected' | 'error'; readonly error?: string }>
}

interface SessionProjectionsService {
  stateOf(session: Session, key: string): unknown
}

interface AgentDefaultModelService {
  saveSelection(selection: ModelSelection): Promise<void>
}

interface CredentialsService {
  set(ref: string, value: string): Promise<void>
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>
}

interface SettingsService {
  describe(options?: { redactSecrets?: boolean }): readonly {
    ns: string
    value: Record<string, unknown>
    schema: unknown
    revision: number
    secrets?: readonly { path: readonly string[]; set: boolean }[]
  }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[], expectedRevision?: number): Promise<void>
}

/**
 * Mount the pi-tui application over one owned Host Agent.
 * @param host - Host plugin context.
 * @param config - resolved terminal configuration.
 * @param onExit - process-exit handoff owned by the Cordis entry.
 * @returns the app controller; disposal restores the terminal without exiting.
 */
export async function startTerminalApp(
  host: Context,
  config: ResolvedConfig,
  onExit: (code: number) => void,
): Promise<TerminalApp> {
  const palette: Palette = createPalette(config.theme)
  const terminal = new ProcessTerminal()
  const tui = config.fullscreen
    ? new TuiAltScreen(terminal, false, undefined, { mouse: true })
    : new TuiMainScreen(terminal, false)
  const header = new Text('', 1, 0)
  const headerRule = new Rule(text => palette.dim(text), 1)
  const status = new Text('', 1, 0)
  const editor = new Editor(tui, editorTheme(palette), { paddingX: 1 })
  const markdown = markdownTheme(palette)
  const renderer = new TranscriptRenderer({
    showReasoning: config.showReasoning,
    thinkingDisplay: config.thinkingDisplay,
    runCodeDisplay: config.runCodeDisplay,
    maxEntries: config.maxTranscriptEntries,
    palette,
    markdown,
  })

  if (tui instanceof TuiAltScreen) {
    const footer = new VStack([
      { component: status, basis: 'auto' },
      { component: editor, basis: 'auto' },
    ])
    tui.setLayoutRoot(new VStack([
      { component: header, basis: 'auto' },
      { component: headerRule, basis: 'auto' },
      {
        component: new ScrollView(renderer.container, { follow: 'end', primary: true, overscroll: 'chain' }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: new Spacer(1), basis: 'auto' },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]))
  } else {
    tui.addChild(header)
    tui.addChild(headerRule)
    tui.addChild(renderer.container)
    tui.addChild(new Spacer(1))
    tui.addChild(status)
    tui.addChild(editor)
  }
  tui.setFocus(editor)

  let active: HostSession
  try {
    active = config.sessionId === undefined
      ? await createHostSession(host, config)
      : await resumeHostSession(host, config.sessionId as SessionId)
  } catch (error) {
    throw new Error('native-tui: failed to open a session: ' + errorMessage(error), { cause: error })
  }

  /** Agent-preset-scoped skill registry, falling back to the host composition. */
  const skillRegistry = (): SkillsCatalog | undefined => {
    try {
      return (active.agent.ctx.get('skills') as SkillsCatalog | undefined) ?? (host.get('skills') as SkillsCatalog | undefined)
    }
    catch {
      return host.get('skills') as SkillsCatalog | undefined
    }
  }
  /** User-invocable skills for the `/` menu and the unknown-command fallback. */
  const loadSkills = async (): Promise<readonly SkillSuggestion[]> => {
    const registry = skillRegistry()
    if (registry === undefined) return []
    try {
      const list = await registry.list({ cwd: config.cwd, scope: active.agent })
      return list
        .filter(skill => skill.invocation === undefined || skill.invocation.userInvocable !== false)
        .map(skill => ({
          name: skill.name,
          description: skill.description,
          modelInvocable: skill.invocation === undefined || skill.invocation.modelInvocable !== false,
        }))
    }
    catch {
      return []
    }
  }
  const autocomplete = new TuiAutocompleteProvider({
    getAgent: () => active.agent,
    getCommands: () => [...LOCAL_COMMANDS, ...host.commands.list(active.agent)],
    getSkills: loadSkills,
    getFileReferences: () => host.get('fileReferences') as import('@deepseek-ai/dsh-file-reference').FileReferenceService | undefined,
    getSessionReferences: () => host.get('sessionReferenceResolver') as SessionReferenceService | undefined,
  })
  editor.setAutocompleteProvider(autocomplete)

  let disposed = false
  let reportedSession = false
  let exiting = false
  let switching = false
  let clearedAfterSeq: number | undefined
  let selectedPreset: string | undefined = sessionAgentPreset(active.agent.session)
    ?? config.agentPreset
    ?? (host.get('agentPresets') as AgentPresetService | undefined)?.defaultId
  let liveSeq = 0
  let entries: TranscriptEntry[] = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
  let localNotices: TranscriptBlock[] = []
  let pendingAttachments: PendingAttachment[] = []
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeSession: (() => void) | undefined
  let interactionDisposers: Array<() => void> = []
  const interactionAbort = new AbortController()
  const attemptPositions = new Map<string, { turn: number; step: number }>()
  let contextWindow: number | undefined
  let modelSelection: ModelSelectionRef = {
    current: sessionModelSelection(active.agent.session) ?? {
      provider: active.agent.options.provider ?? 'deepseek-official',
      model: active.agent.options.model ?? 'deepseek-flash',
      ...(active.agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: active.agent.options.reasoningEffort }),
    },
    assembled: undefined,
  }
  let disposeModelSelection: (() => void) | undefined
  disposeModelSelection = installModelSelection(active.agent.ctx, modelSelection)

  const summaryCwd = (): string | undefined => active.agent.session.header.cwd ?? config.cwd

  const lastDurableSeq = (): number | undefined => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.type === 'event') return Number(entry.event.seq)
    }
    return undefined
  }

  const renderTranscript = (): void => {
    if (disposed) return
    const visible = clearedAfterSeq === undefined
      ? entries
      : entries.filter((entry) => entry.type === 'live' || Number(entry.event.seq) > clearedAfterSeq!)
    renderer.set(visible, localNotices)
    tui.requestRender()
  }

  const scheduleTranscript = (immediate = false): void => {
    if (disposed) return
    if (immediate) {
      if (transcriptTimer !== undefined) {
        clearTimeout(transcriptTimer)
        transcriptTimer = undefined
      }
      renderTranscript()
      return
    }
    if (transcriptTimer !== undefined) return
    transcriptTimer = setTimeout(() => {
      transcriptTimer = undefined
      renderTranscript()
    }, 33)
  }

  const pushNotice = (tone: 'info' | 'warning' | 'error', text: string): void => {
    localNotices.push({ kind: 'notice', tone, text, afterSeq: lastDurableSeq() ?? 0 })
    if (localNotices.length > MAX_NOTICES) localNotices = localNotices.slice(-MAX_NOTICES)
    scheduleTranscript(true)
  }

  const renderStatus = (): void => {
    if (disposed) return
    const options = active.agent.options
    const projections = host.get('sessionProjections') as SessionProjectionsService | undefined
    renderStatusRows({ header, status }, palette, {
      title: config.title,
      sessionId: active.id,
      cwd: summaryCwd() ?? config.cwd,
      running: active.agent.status === 'running',
      provider: modelSelection.current?.provider ?? options.provider ?? 'deepseek-official',
      model: modelSelection.current?.model ?? options.model ?? 'deepseek-flash',
      reasoningEffort: modelSelection.current?.reasoningEffort,
      preset: currentPreset(host.get('agentPresets') as AgentPresetService | undefined, active.agent.ctx),
      attachmentCount: pendingAttachments.length,
      contextWindow,
      stats: projections?.stateOf(active.agent.session, 'sessionStats') as SessionStats | undefined,
      events: active.agent.session.snapshotEvents(),
    })
    tui.requestRender()
  }

  const refreshContextWindow = async (): Promise<void> => {
    const llm = host.get('llm') as LlmCatalog | undefined
    const current = modelSelection.current
    if (llm === undefined || current === undefined) return
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      contextWindow = info.context?.contextWindow
      renderStatus()
    }
    catch {
      // The model may be temporarily unroutable; metrics keep the last known capacity.
    }
  }

  const subscribeActive = (): void => {
    unsubscribeSession = subscribeSessionEvents({
      host,
      sessionId: () => active.id,
      appendEntry: entry => { entries.push(entry) },
      replaceEntries: update => { entries = update(entries) },
      notice: text => pushNotice('info', text),
      scheduleTranscript: () => scheduleTranscript(),
      renderStatus,
      beginAttempt: (id, turn, step) => { attemptPositions.set(id, { turn, step }) },
      endAttempt: id => { attemptPositions.delete(id) },
      nextLiveSeq: () => { liveSeq += 1; return liveSeq },
      attemptPosition: id => attemptPositions.get(id),
    })
    scheduleTranscript(true)
    renderStatus()
  }

  const clearSubscriptions = (): void => {
    unsubscribeSession?.()
    unsubscribeSession = undefined
    if (transcriptTimer !== undefined) {
      clearTimeout(transcriptTimer)
      transcriptTimer = undefined
    }
  }

  const registerInteractions = (): void => {
    const agent = active.agent
    interactionDisposers = [
      agent.ctx.on('approval/request', async (request, next) => {
        if (request.agent !== agent) return next()
        return showApproval(tui, palette, request, request.signal === undefined
          ? interactionAbort.signal
          : AbortSignal.any([request.signal, interactionAbort.signal]))
      }),
      agent.ctx.on('user-questions/request', async (request, next) => {
        if (request.agent !== agent) return next()
        return showQuestionBatch(tui, palette, request.questions, request.signal === undefined
          ? interactionAbort.signal
          : AbortSignal.any([request.signal, interactionAbort.signal]))
      }),
    ]
  }

  const disposeInteractions = (): void => {
    for (const dispose of interactionDisposers) dispose()
    interactionDisposers = []
  }

  const listSessions = async (): Promise<void> => {
    await sessionsCommand(commandContext())
  }

  const switchTo = async (next: () => Promise<HostSession>): Promise<void> => {
    if (switching || disposed) return
    switching = true
    try {
      const opened = await next()
      disposeInteractions()
      disposeModelSelection?.()
      disposeModelSelection = undefined
      clearSubscriptions()
      await active.dispose()
      active = opened
      selectedPreset = sessionAgentPreset(active.agent.session) ?? selectedPreset
      entries = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
      clearedAfterSeq = undefined
      liveSeq = 0
      localNotices = []
      renderer.clear()
      tui.setFocus(editor)
      modelSelection = {
        current: sessionModelSelection(active.agent.session) ?? {
          provider: active.agent.options.provider ?? 'deepseek-official',
          model: active.agent.options.model ?? 'deepseek-flash',
          ...(active.agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: active.agent.options.reasoningEffort }),
        },
        assembled: undefined,
      }
      disposeModelSelection = installModelSelection(active.agent.ctx, modelSelection)
      contextWindow = undefined
      registerInteractions()
      subscribeActive()
      void refreshContextWindow()
      pushNotice('info', 'Switched to ' + active.id)
    } catch (error) {
      pushNotice('error', 'Could not open the session: ' + errorMessage(error))
    } finally {
      switching = false
    }
  }

  const sendPrompt = (text: string): void => {
    const content: ContentBlock[] = []
    if (text.trim() !== '') content.push({ type: 'text', text })
    for (const pending of pendingAttachments) content.push(pending.block)
    if (content.length === 0) return
    try {
      const message = createUserMessage({
        content,
        source: { kind: 'user' },
      })
      if (active.agent.status === 'running') active.agent.steer(message)
      else active.agent.followup(message)
      pendingAttachments = []
      editor.addToHistory(text)
      renderStatus()
    } catch (error) {
      pushNotice('error', 'Prompt failed: ' + errorMessage(error))
    }
  }

  const persistSelection = async (): Promise<void> => {
    const service = host.get('agentDefaultModel') as AgentDefaultModelService | undefined
    const current = modelSelection.current
    if (service === undefined || current === undefined) return
    try {
      await service.saveSelection(current)
    } catch (error) {
      pushNotice('warning', 'Selection applies now but could not be saved: ' + errorMessage(error))
    }
  }

  /**
   * The handler-facing view of this application. It is built per command run so
   * a handler always sees the session that is on screen now, not the one that
   * was active when this closure was created.
   */
  const commandContext = (): CommandContext => ({
    host,
    config,
    palette,
    tui,
    active,
    signal: interactionAbort.signal,
    notice: pushNotice,
    renderStatus,
    attachments: {
      pending: pendingAttachments,
      clear: () => { pendingAttachments = [] },
    },
    runCommand: line => runCommand(line),
    openTuiSettings: () => openTuiSettings(commandContext()),
    showHostSettings: () => showHostSettings(commandContext()),
    modelSelection,
    setContextWindow: tokens => { contextWindow = tokens },
    persistSelection,
  })

  const runCommand = async (line: string): Promise<void> => {
    const withoutSlash = line.slice(1)
    const space = withoutSlash.indexOf(' ')
    const name = (space === -1 ? withoutSlash : withoutSlash.slice(0, space)).toLowerCase()
    const args = space === -1 ? '' : withoutSlash.slice(space + 1).trim()

    switch (name) {
      case 'exit':
      case 'quit':
        requestExit(0)
        return
      case 'help': {
        await helpCommand(commandContext(), HELP_LINES)
        return
      }
      case 'clear':
        clearedAfterSeq = lastDurableSeq()
        entries = []
        localNotices = []
        renderer.clear()
        scheduleTranscript(true)
        return
      case 'status': {
        statusCommand(commandContext())
        return
      }
      case 'cancel':
        active.agent.cancel({ kind: 'user' })
        pushNotice('info', 'Cancellation requested')
        return
      case 'new':
        await switchTo(() => createHostSession(host, {
          ...config,
          sessionId: undefined,
          agentPreset: selectedPreset ?? config.agentPreset,
        }))
        return
      case 'init':
        sendPrompt(INIT_AGENTS_PROMPT)
        return
      case 'sessions':
        await listSessions()
        return
      case 'resume':
        if (args === '') await listSessions()
        else await switchTo(() => resumeHostSession(host, args as SessionId))
        return
      case 'model': {
        await modelCommand(commandContext(), args)
        return
      }
      case 'reasoning': {
        await reasoningCommand(commandContext(), args)
        return
      }
      case 'permissions': {
        await permissionsCommand(commandContext(), args)
        return
      }
      case 'jobs': {
        jobsCommand(commandContext(), args)
        return
      }
      case 'agents': {
        await agentsCommand(commandContext())
        return
      }
      case 'workspaces': {
        await workspacesCommand(commandContext(), args, switchTo, () => selectedPreset)
        return
      }
      case 'schedule': {
        await scheduleCommand(commandContext(), args)
        return
      }
      case 'plugins': {
        await pluginsCommand(commandContext(), args)
        return
      }
      case 'settings': {
        await settingsCommand(commandContext(), args)
        return
      }
            case 'preset': {
              await presetCommand(commandContext(), args, () => selectedPreset, id => { selectedPreset = id })
              return;
            }
            case 'export': {
              await exportCommand(commandContext(), args)
              return;
            }
            case 'open': {
              await openCommand(commandContext(), args)
              return;
            }
            case 'attach': {
              await attachCommand(commandContext(), args)
              return;
            }
            case 'files': {
              await filesCommand(commandContext(), args)
              return;
            }
            case 'changes': {
              await changesCommand(commandContext(), args)
              return;
            }
            case 'deliverables': {
              await deliverablesCommand(commandContext(), args)
              return;
            }
            case 'preview': {
              await previewCommand(commandContext(), args)
              return;
            }
            case 'tools': {
              toolsCommand(commandContext())
              return;
            }
            case 'tool': {
              await toolCommand(commandContext(), args)
              return;
            }
            case 'diff': {
              await diffCommand(commandContext(), args)
              return;
            }
            case 'attachments': {
              await attachmentsCommand(commandContext())
              return;
            }
            case 'mcp': {
              await mcpCommand(commandContext(), args)
              return;
            }
            case 'codebuddy': {
                const codebuddyService = host.get('codebuddy') as CodeBuddyService | undefined;
                await runCodebuddyCommand(args, {
                    service: codebuddyService,
                    authorization: host.get('authorization') as CodeBuddyCommandDeps['authorization'],
                    credentials: host.get('credentials') as CodeBuddyCommandDeps['credentials'],
                    openUrl: url => openUrlInBrowser(url),
                    signal: interactionAbort.signal,
                    notice: (level, text) => pushNotice(level, text),
                    prompt: question => showTextInput(
                        tui,
                        palette,
                        question.message,
                        question.placeholder ?? '',
                        question.secret === true ? 'Input is hidden from the transcript · Esc cancels' : 'Enter submits · Esc cancels',
                        interactionAbort.signal,
                    ),
                });
                return;
            }
            case 'provider': {
              await providerCommand(commandContext(), args)
              return;
            }
            default: {
                try {
                    const execution = await host.commands.execute(active.agent, line, [], new AbortController().signal);
                    if (execution !== undefined) {
                        // Host commands append command/done before execute() resolves, and the
                        // transcript renders that event. Do not also surface result.text here.
                        return;
                    }
                }
                catch (error) {
                    pushNotice('error', 'Command failed: ' + errorMessage(error));
                    return;
                }
                // A user-invocable skill goes through as a prompt: dsh-tool-skill reads the
                // /name gesture from claimed user messages and injects the skill body.
                const skills = await loadSkills();
                if (skills.some(skill => skill.name.toLowerCase() === name)) {
                    sendPrompt(line);
                    return;
                }
                pushNotice('warning', 'Unknown command: /' + name + '. Use /help for local and host commands.');
            }
        }
    };
    const handleSubmit = (text: string): void => {
        const trimmed = text.trim();
        if (trimmed === '' && pendingAttachments.length === 0)
            return;
        editor.setText('');
        if (trimmed === 'exit' || trimmed === 'quit') {
            requestExit(0);
            return;
        }
        if (trimmed.startsWith('/')) {
            void runCommand(trimmed);
            return;
        }
        sendPrompt(trimmed);
    };
    const requestExit = (code: number): void => {
        if (exiting || disposed)
            return;
        exiting = true;
        void dispose().then(() => { onExit(code); }, () => { onExit(code); });
    };
    const onSignal = () => {
        void dispose().finally(() => { process.exit(143); });
    };
    const dispose = async () => {
        if (disposed)
            return;
        disposed = true;
        interactionAbort.abort(new Error('native-tui: terminal disposed'));
        disposeModelSelection?.();
        disposeModelSelection = undefined;
        disposeInteractions();
        clearSubscriptions();
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
        try {
            tui.stop();
        }
        catch {
            // The terminal may already be gone; restoration is best-effort here.
        }
        if (!reportedSession) {
            reportedSession = true;
            try {
                process.stdout.write('\nSession: ' + active.id + '\nResume: dsh --profile tui --resume ' + active.id + '\n');
            }
            catch {
                // A closed stdout must not turn a normal exit into a failure.
            }
        }
        await active.dispose();
    };
    editor.onSubmit = handleSubmit;
    tui.addInputListener((data) => {
        const shortcut = globalShortcut(data, active.agent.status === 'running');
        if (shortcut === undefined)
            return undefined;
        if (shortcut === 'cancel-turn') {
            if (tui.hasOverlay())
                return undefined;
            active.agent.cancel({ kind: 'user' });
            return { consume: true };
        }
        requestExit(0);
        return { consume: true };
    });
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    try {
        registerInteractions();
        subscribeActive();
        tui.start();
        tui.setFocus(editor);
        tui.requestRender();
        void refreshContextWindow();
    }
    catch (error) {
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
        await dispose();
        throw error;
    }
    return {
        setDisplayModes: (thinkingDisplay, runCodeDisplay) => {
            if (disposed) return;
            renderer.setDisplayModes(thinkingDisplay, runCodeDisplay);
            tui.requestRender();
        },
        setMaxEntries: (maxEntries) => {
            if (disposed) return;
            renderer.setMaxEntries(maxEntries);
            tui.requestRender();
        },
        dispose: async () => {
            await dispose();
        },
    };
}
//# sourceMappingURL=app.js.map