import {
  Editor,
  getNativeClipboard,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { dirname, resolve } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { createHostSession, resumeHostSession, type AgentPresetService, type HostSession } from '../runtime/agent.js'
import { exportSessionLog } from '../runtime/export.js'
import { exportSessionBundle } from '../runtime/bundle.js'
import { exportSessionHtml } from '../runtime/html.js'
import { isMarkdownPath, listDirectory, readTextPreview, sanitizeTerminalText } from '../runtime/files.js'
import { settingsChildFields, settingsFields, settingsSetAt, settingsValueAt } from '../runtime/settings.js'
import { readImagePreview } from '../runtime/images.js'
import { revealWithSystemApp, systemRevealCommand } from '../runtime/open.js'
import { collectDeliverables, formatDeliverables, type PresentedFileView } from '../runtime/deliverables.js'
import { collectToolCalls } from '../runtime/tool-log.js'
import {
  buildCatalogProvider,
  buildCustomProvider,
  isValidEnvName,
  isValidProviderRoute,
  mergeDiscoveredProviderModels,
  mergeProviderModel,
  parseReasoningLevels,
  type ProviderProtocol,
} from '../runtime/providers.js'
import {
  formatChangesSummary,
  formatWorkspaceDiff,
  type ChangesSummaryView,
  type WorkspaceDiffView,
} from '../runtime/changes.js'
import {
  detectImageMediaType,
  imageExtension,
  loadAttachment,
  MAX_ATTACHMENT_BYTES,
  type AttachmentsService,
  type PendingAttachment,
} from '../runtime/attachments.js'
import { showApproval, showChoice, showImagePreview, showMarkdownPreview, showQuestionBatch, showTextInput, showTextPager } from './dialogs.js'
import { TuiAutocompleteProvider, type CommandSuggestion, type SessionReferenceService } from './autocomplete.js'
import { createPalette, editorTheme, markdownTheme, type Palette } from './theme.js'
import { TranscriptRenderer, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import { Rule } from './rule.js'
import { diffLines } from './diff.js'

/** Terminal application lifecycle. */
export interface TerminalApp {
  dispose(): Promise<void>
}

const MAX_NOTICES = 12
const NL = String.fromCharCode(10)

const LOCAL_COMMANDS: readonly CommandSuggestion[] = [
  { name: 'help', description: 'show local and host commands' },
  { name: 'new', description: 'create a new session' },
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
  { name: 'settings', description: 'list, field/array-edit, or JSON-set settings', input: { hint: '[edit <ns>|items <ns> <field>|set <ns> <json>]' }, subcommands: [
    { name: 'edit', description: 'edit a settings namespace', hint: '<ns>' },
    { name: 'items', description: 'edit an array item', hint: '<ns> <field>' },
    { name: 'set', description: 'merge JSON into a namespace', hint: '<ns> <json>' },
  ] },
  { name: 'mcp', description: 'configure MCP servers', input: { hint: '[add|list|remove <name>]' }, subcommands: [
    { name: 'add', description: 'add a stdio or HTTP MCP server' },
    { name: 'list', description: 'list configured MCP servers' },
    { name: 'remove', description: 'remove an MCP server', hint: '<name>' },
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
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }>
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
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]))
  } else {
    tui.addChild(header)
    tui.addChild(headerRule)
    tui.addChild(renderer.container)
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

  const autocomplete = new TuiAutocompleteProvider({
    getAgent: () => active.agent,
    getCommands: () => [...LOCAL_COMMANDS, ...host.commands.list(active.agent)],
    getFileReferences: () => host.get('fileReferences') as import('@deepseek-ai/dsh-file-reference').FileReferenceService | undefined,
    getSessionReferences: () => host.get('sessionReferenceResolver') as SessionReferenceService | undefined,
  })
  editor.setAutocompleteProvider(autocomplete)

  let disposed = false
  let exiting = false
  let switching = false
  let clearedAfterSeq: number | undefined
  let selectedPreset: string | undefined = config.agentPreset
    ?? (host.get('agentPresets') as AgentPresetService | undefined)?.defaultId
  let liveSeq = 0
  let entries: TranscriptEntry[] = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
  let localNotices: TranscriptBlock[] = []
  let pendingAttachments: PendingAttachment[] = []
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeSession: (() => void) | undefined
  let unsubscribeStream: (() => void) | undefined
  let unsubscribeStatus: (() => void) | undefined
  let interactionDisposers: Array<() => void> = []
  const interactionAbort = new AbortController()
  const attemptPositions = new Map<string, { turn: number; step: number }>()
  let modelSelection: ModelSelectionRef = {
    current: {
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
    const provider = modelSelection.current?.provider ?? options.provider ?? 'deepseek-official'
    const model = modelSelection.current?.model ?? options.model ?? 'deepseek-flash'
    header.setText(
      palette.bold(palette.brand('◆ ' + config.title)) + '  ' + palette.dim(active.id) + '\n'
      + palette.dim((summaryCwd() ?? config.cwd) + '  ·  ' + provider + '/' + model),
    )
    const state = active.agent.status === 'running'
      ? palette.warning('● working')
      : palette.success('● idle')
    const preset = (host.get('agentPresets') as AgentPresetService | undefined)?.composedPreset(active.agent.ctx)
    const bits = [state]
    if (preset !== undefined) bits.push(palette.dim('preset ' + preset))
    const effort = modelSelection.current?.reasoningEffort
    if (effort !== undefined) bits.push(palette.dim('effort ' + String(effort)))
    if (pendingAttachments.length > 0) bits.push(palette.dim('attached ' + String(pendingAttachments.length)))
    const hint = active.agent.status === 'running'
      ? 'enter steer · esc cancel · ctrl+c cancel · ctrl+d exit'
      : 'enter send · /help · ctrl+d exit'
    status.setText(bits.join('  ') + '   ' + palette.dim(hint))
    tui.requestRender()
  }

  const subscribeActive = (): void => {
    unsubscribeSession = host.on('session/event', (session, event) => {
      if (session.id !== active.id) return
      if (event.type === 'assistant/message') {
        entries = entries.filter(entry => !(
          entry.type === 'live'
          && entry.event.data.turn === event.data.turn
          && entry.event.data.step === event.data.step
        ))
      }
      entries.push({ type: 'event', event })
      if ((event.type as string) === 'workspace/changes') {
        const changes = host.get('workspaceChanges') as WorkspaceChangesService | undefined
        const summary = changes?.summary(session.id, Number(event.seq))
        if (summary !== undefined) pushNotice('info', formatChangesSummary(summary))
      }
      if ((event.type as string) === 'deliverables/presented') {
        const data = event.data as { readonly turn: number; readonly files: readonly PresentedFileView[] }
        pushNotice('info', formatDeliverables([{ turn: data.turn, files: data.files }]))
      }
      scheduleTranscript()
      renderStatus()
    })
    unsubscribeStream = host.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent.id !== active.id) return
      if (frame.type === 'start') {
        attemptPositions.set(String(frame.attemptId), { turn: frame.turn, step: frame.step })
        return
      }
      if (frame.type === 'end') {
        attemptPositions.delete(String(frame.attemptId))
        return
      }
      const position = attemptPositions.get(String(frame.attemptId)) ?? { turn: 0, step: 0 }
      liveSeq += 1
      entries.push({
        type: 'live',
        event: {
          type: 'assistant/live-chunk',
          seq: liveSeq,
          time: frame.time,
          data: {
            attemptId: String(frame.attemptId),
            turn: position.turn,
            step: position.step,
            chunk: frame.chunk,
          },
        },
      })
      scheduleTranscript()
    })
    unsubscribeStatus = host.on('agent/status', ({ agent }) => {
      if (agent.id === active.id) renderStatus()
    })
    scheduleTranscript(true)
    renderStatus()
  }

  const clearSubscriptions = (): void => {
    unsubscribeSession?.()
    unsubscribeSession = undefined
    unsubscribeStream?.()
    unsubscribeStream = undefined
    unsubscribeStatus?.()
    unsubscribeStatus = undefined
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
    const persistence = host.get('sessionPersistence') as {
      list(): Promise<readonly { header: { id: SessionId; cwd?: string; createdAt: number; origin?: string } }[]>
    } | undefined
    if (persistence === undefined) {
      pushNotice('warning', 'Session persistence is unavailable; only the current session can be used.')
      return
    }
    try {
      const rows = (await persistence.list())
        .filter(row => row.header.origin !== 'subagent')
        .slice(0, 12)
      if (rows.length === 0) {
        pushNotice('info', 'No stored sessions yet. Use /new to create one.')
        return
      }
      const lines = rows.map(row => {
        const marker = row.header.id === active.id ? '*' : ' '
        return marker + ' ' + row.header.id + '  ' + (row.header.cwd ?? '') + '  ' + new Date(row.header.createdAt).toISOString()
      })
      pushNotice('info', 'Sessions:' + NL + lines.join(NL) + NL + 'Use /resume <session-id> to switch.')
    } catch (error) {
      pushNotice('error', 'Could not list sessions: ' + errorMessage(error))
    }
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
      entries = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
      clearedAfterSeq = undefined
      liveSeq = 0
      localNotices = []
      renderer.clear()
      tui.setFocus(editor)
      modelSelection = {
        current: {
          provider: active.agent.options.provider ?? 'deepseek-official',
          model: active.agent.options.model ?? 'deepseek-flash',
          ...(active.agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: active.agent.options.reasoningEffort }),
        },
        assembled: undefined,
      }
      disposeModelSelection = installModelSelection(active.agent.ctx, modelSelection)
      registerInteractions()
      subscribeActive()
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

  const selectModel = async (llm: LlmCatalog, target: string): Promise<void> => {
    const slash = target.indexOf('/')
    const provider = slash === -1
      ? (modelSelection.current?.provider ?? active.agent.options.provider ?? 'deepseek-official')
      : target.slice(0, slash)
    const model = slash === -1 ? target : target.slice(slash + 1)
    if (provider === '' || model === '') {
      pushNotice('warning', 'Usage: /model [provider/model]')
      return
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info.reasoning
      let effort = modelSelection.current?.reasoningEffort
      if (effort !== undefined && reasoning?.efforts.some(candidate => candidate.id === effort) !== true)
        effort = undefined
      if (effort === undefined && reasoning?.defaultEffort !== undefined)
        effort = ReasoningEffortId(reasoning.defaultEffort)
      modelSelection.current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      pushNotice('info', 'Model selected: ' + provider + '/' + model + ' (applies to the next step)')
      if (reasoning !== undefined && reasoning.efforts.length > 0) {
        pushNotice('info', 'Reasoning efforts: ' + reasoning.efforts.map(candidate => candidate.id).join(', ') + ' — use /reasoning')
      }
      await persistSelection()
      renderStatus()
    } catch (error) {
      pushNotice('error', 'Unroutable model ' + provider + '/' + model + ': ' + errorMessage(error))
    }
  }

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
        const hostCommands = host.commands.list(active.agent)
          .map(command => '/' + command.name + (command.input === undefined ? '' : ' ' + command.input.hint))
        pushNotice('info', [
          'Local commands:',
          '/help · /new · /sessions · /resume [id] · /status · /clear',
          '/exit · /quit (or bare exit/quit)',
          '/cancel · /model [provider/model] · /reasoning [effort] · /provider [add|list|edit|models|remove <route>]',
          '/mcp [add|list|remove <name>]',
          '/permissions [preset]',
          '/jobs [kill <id>] · /agents · /preset [id]',
          '/plugins [list|market [q]|inspect <spec>|install <spec>|remove <bundle>|enable <id>|disable <id>] · /exit',
          '/workspaces [new|use|pin|unpin|archive|unarchive] · /schedule [add|delete]',
          '/schedule [add <seconds> <title>|delete <id>] · /plugins · /exit',
          '/settings [edit <ns>|items <ns> <field>|set <ns> <json>] · /export [path|zip|html] · /open <path> · /preview <image>',
          '/files [path] · /changes [diff <index>] · /deliverables [panel|open|reveal <index>]',
          '/tools · /tool <index> · /diff [index] · /exit',
          '/attach <path>|paste|preview <i>|list|clear · /attachments · /exit',
          '@@<query> references another session · /exit',
          'Host commands: ' + (hostCommands.length === 0 ? '(none)' : hostCommands.join(' · ')),
          'Enter sends; when the agent runs, Enter steers and Esc cancels.',
        ].join(NL))
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
        const headerInfo = active.agent.session.header
        const options = active.agent.options
        pushNotice('info', [
          'Session: ' + active.id,
          'Directory: ' + (headerInfo.cwd ?? config.cwd),
          'Model: ' + (modelSelection.current?.provider ?? options.provider ?? 'deepseek-official') + '/' + (modelSelection.current?.model ?? options.model ?? 'deepseek-flash'),
          'Reasoning: ' + (modelSelection.current?.reasoningEffort ?? 'provider default'),
          'State: ' + active.agent.status,
          'Preset: ' + ((host.get('agentPresets') as AgentPresetService | undefined)?.composedPreset(active.agent.ctx) ?? '(none)'),
          'Events: ' + String(active.agent.session.snapshotEvents().length),
          'Created: ' + new Date(headerInfo.createdAt).toISOString(),
        ].join(NL))
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
      case 'sessions':
        await listSessions()
        return
      case 'resume':
        if (args === '') await listSessions()
        else await switchTo(() => resumeHostSession(host, args as SessionId))
        return
      case 'model': {
        const llm = host.get('llm') as LlmCatalog | undefined
        if (llm === undefined) {
          pushNotice('warning', 'The LLM catalog service is unavailable.')
          return
        }
        if (args !== '') {
          await selectModel(llm, args)
          return
        }
        const items: Array<{ value: string; label: string; description?: string }> = []
        for (const provider of llm.listProviders()) {
          let models: readonly { id: string; name: string; description?: string }[] = []
          try {
            models = await llm.listModels(provider.id)
          } catch {
            continue
          }
          for (const model of models) {
            const value = provider.id + '/' + model.id
            const current = modelSelection.current?.provider === provider.id && modelSelection.current?.model === model.id
            items.push({
              value,
              label: (current ? '* ' : '  ') + value,
              description: model.name + (model.description === undefined ? '' : ' — ' + model.description),
            })
          }
        }
        if (items.length === 0) {
          pushNotice('warning', 'The LLM catalog advertises no models.')
          return
        }
        const selectedModel = await showChoice(tui, palette, 'Select model', items, 'Enter selects · Esc cancels', interactionAbort.signal)
        if (selectedModel !== undefined) await selectModel(llm, selectedModel)
        return
      }
      case 'reasoning': {
        const llm = host.get('llm') as LlmCatalog | undefined;
        const selected = modelSelection.current;
        if (llm === undefined || selected === undefined) {
            pushNotice('warning', 'No active model selection is available.');
            return;
        }
        try {
            const info = await llm.resolveModelInfo(selected.provider, selected.model);
            const reasoning = info.reasoning;
            if (reasoning === undefined || reasoning.efforts.length === 0) {
                pushNotice('warning', 'Model ' + selected.provider + '/' + selected.model + ' exposes no reasoning efforts. Add reasoningEfforts to the provider model or choose another model.');
                return;
            }
            const applyEffort = async (effort: string | undefined): Promise<void> => {
                const current = modelSelection.current;
                if (current === undefined)
                    return;
                modelSelection.current = {
                    provider: current.provider,
                    model: current.model,
                    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
                };
                pushNotice('info', 'Reasoning effort: ' + (effort ?? 'provider default'));
                await persistSelection();
                renderStatus();
            };
            const currentEffort = selected.reasoningEffort;
            if (args !== '') {
                const requested = args.trim().toLowerCase();
                if (requested === 'default' || requested === 'auto' || requested === 'clear') {
                    await applyEffort(undefined);
                    return;
                }
                if (!reasoning.efforts.some(candidate => candidate.id === requested)) {
                    pushNotice('warning', 'Unknown reasoning effort "' + requested + '". Available: ' + reasoning.efforts.map(candidate => candidate.id).join(', '));
                    return;
                }
                await applyEffort(requested);
                return;
            }
            const items: Array<{ value: string; label: string; description?: string }> = [{
                value: '__default__',
                label: (currentEffort === undefined ? '* ' : '  ') + 'provider default',
                description: 'Omit an explicit reasoning effort',
            }];
            for (const candidate of reasoning.efforts) {
                items.push({
                    value: candidate.id,
                    label: (candidate.id === currentEffort ? '* ' : '  ') + candidate.id,
                    description: candidate.name + (candidate.description === undefined ? '' : ' — ' + candidate.description),
                });
            }
            const choice = await showChoice(
                tui,
                palette,
                'Reasoning effort (current: ' + (currentEffort ?? 'provider default') + ')',
                items,
                'Enter selects · Esc cancels',
                interactionAbort.signal,
            );
            if (choice === undefined)
                return;
            await applyEffort(choice === '__default__' ? undefined : choice);
        }
        catch (error) {
            pushNotice('error', 'Could not inspect reasoning efforts: ' + errorMessage(error));
        }
        return;
      }
      case 'permissions': {
        const presets = host.get('permissionPresets') as PermissionPresets | undefined
        if (presets === undefined) {
          pushNotice('warning', 'The permission-preset service is unavailable.')
          return
        }
        if (args !== '') {
          if (!presets.names.includes(args)) {
            pushNotice('warning', 'Unknown preset "' + args + '". Available: ' + presets.names.join(', '))
            return
          }
          presets.set(active.agent.session, args)
          pushNotice('info', 'Permission preset: ' + args)
          renderStatus()
          return
        }
        const currentPreset = presets.current(active.agent.session)
        const presetChoice = await showChoice(
          tui,
          palette,
          'Permission preset (current: ' + currentPreset + ')',
          presets.names.map(name => ({
            value: name,
            label: (name === currentPreset ? '* ' : '  ') + name,
            description: name === 'workspace-write' ? 'Workspace writes only' : 'Full host access',
          })),
          'Enter selects · Esc cancels',
          interactionAbort.signal,
        )
        if (presetChoice !== undefined) {
          presets.set(active.agent.session, presetChoice)
          pushNotice('info', 'Permission preset: ' + presetChoice)
          renderStatus()
        }
        return
      }
      case 'jobs': {
        const jobs = host.get('jobs') as JobsService | undefined
        if (jobs === undefined) {
          pushNotice('warning', 'The background-jobs service is unavailable.')
          return
        }
        if (args.startsWith('kill ')) {
          const id = args.slice('kill '.length).trim()
          if (id === '') {
            pushNotice('warning', 'Usage: /jobs kill <job-id>')
            return
          }
          try {
            const outcome = jobs.kill(id, active.id, 'user requested from native-tui')
            pushNotice('info', 'Kill ' + id + ': ' + outcome)
          } catch (error) {
            pushNotice('error', 'Kill failed: ' + errorMessage(error))
          }
          return
        }
        try {
          const rows = jobs.list(active.id)
          if (rows.length === 0) {
            pushNotice('info', 'No background jobs for this session.')
            return
          }
          pushNotice('info', 'Jobs:' + NL + rows.map(row => row.id + '  ' + row.status + '  ' + row.kind + '  ' + row.label
            + (row.progress === undefined ? '' : '  ' + row.progress)
            + (row.detail === undefined ? '' : '  ' + row.detail)).join(NL))
        } catch (error) {
          pushNotice('error', 'Could not list jobs: ' + errorMessage(error))
        }
        return
      }
      case 'agents': {
        const subagents = host.get('subagents') as SubagentsService | undefined
        if (subagents === undefined) {
          pushNotice('warning', 'The subagent service is unavailable.')
          return
        }
        try {
          const rows = await subagents.listChildren(active.id)
          if (rows.length === 0) {
            pushNotice('info', 'No subagents for this session.')
            return
          }
          pushNotice('info', 'Subagents:' + NL + rows.map(row => row.id + '  ' + row.mode + '  ' + (row.label ?? '')
            + '  ' + new Date(row.createdAt).toISOString()).join(NL))
        } catch (error) {
          pushNotice('error', 'Could not list subagents: ' + errorMessage(error))
        }
        return
      }
      case 'workspaces': {
        const workspaceService = host.get('workspaceRegistry') as unknown as WorkspaceService | undefined
        if (workspaceService === undefined) {
          pushNotice('warning', 'The workspace registry is unavailable.')
          return
        }
        if (args === '') {
          const currentPath = active.agent.session.header.cwd ?? config.cwd
          const rows = workspaceService.list()
          if (rows.length === 0) {
            pushNotice('info', 'No workspaces. Use /workspaces new <path>.')
            return
          }
          pushNotice('info', 'Workspaces:' + NL + rows.map(row => {
            const marker = row.path === currentPath ? '*' : ' '
            return marker + ' ' + row.id + '  ' + row.title + '  ' + row.path + '  (' + String(row.sessionIds.length) + ' sessions)'
          }).join(NL) + NL + 'Use /workspaces use <id|path> to start a session there.')
          return
        }
        const parts = args.split(/\s+/u)
        const subcommand = parts[0] ?? ''
        const rest = args.slice(subcommand.length).trim()
        if (subcommand === 'new') {
          if (rest === '') {
            pushNotice('warning', 'Usage: /workspaces new <path> [title]')
            return
          }
          const firstSpace = rest.indexOf(' ')
          const path = firstSpace === -1 ? rest : rest.slice(0, firstSpace)
          const title = firstSpace === -1 ? undefined : rest.slice(firstSpace + 1).trim()
          try {
            const created = await workspaceService.create(path, title === '' ? undefined : title)
            pushNotice('info', 'Workspace created: ' + created.id + '  ' + created.path)
          } catch (error) {
            pushNotice('error', 'Could not create workspace: ' + errorMessage(error))
          }
          return
        }
        if (subcommand === 'use') {
          if (rest === '') {
            pushNotice('warning', 'Usage: /workspaces use <id|path>')
            return
          }
          try {
            const workspace = workspaceService.get(rest) ?? await workspaceService.resolveByPath(rest)
            if (workspace === undefined) {
              pushNotice('warning', 'No workspace matches ' + rest)
              return
            }
            await switchTo(() => createHostSession(host, {
              ...config,
              sessionId: undefined,
              cwd: workspace.path,
              agentPreset: selectedPreset ?? config.agentPreset,
            }))
          } catch (error) {
            pushNotice('error', 'Could not switch workspace: ' + errorMessage(error))
          }
          return
        }
        if (subcommand === 'pin' || subcommand === 'unpin') {
          const id = rest === '' ? active.id : rest as SessionId
          try {
            if (subcommand === 'pin') await workspaceService.pinSession(id)
            else await workspaceService.unpinSession(id)
            pushNotice('info', (subcommand === 'pin' ? 'Pinned ' : 'Unpinned ') + id)
          } catch (error) {
            pushNotice('error', 'Could not ' + subcommand + ' session: ' + errorMessage(error))
          }
          return
        }
        if (subcommand === 'archive' || subcommand === 'unarchive') {
          if (rest === '') {
            pushNotice('warning', 'Usage: /workspaces ' + subcommand + ' <session-id>')
            return
          }
          if (subcommand === 'archive' && rest === active.id) {
            pushNotice('warning', 'Refusing to archive the active session; switch to another session first.')
            return
          }
          try {
            if (subcommand === 'archive') await workspaceService.archiveSession(rest as SessionId)
            else await workspaceService.unarchiveSession(rest as SessionId)
            pushNotice('info', (subcommand === 'archive' ? 'Archived ' : 'Unarchived ') + rest)
          } catch (error) {
            pushNotice('error', 'Could not ' + subcommand + ' session: ' + errorMessage(error))
          }
          return
        }
        pushNotice('warning', 'Usage: /workspaces [new <path> [title] | use <id|path> | pin|unpin|archive|unarchive <id>]')
        return
      }
      case 'schedule': {
        const scheduleService = host.get('schedule') as unknown as ScheduleService | undefined
        if (scheduleService === undefined) {
          pushNotice('warning', 'The schedule service is unavailable.')
          return
        }
        if (args === '') {
          try {
            const rows = await scheduleService.list({ sessionId: active.id })
            if (rows.length === 0) {
              pushNotice('info', 'No active reminders for this session.')
              return
            }
            pushNotice('info', 'Reminders:' + NL + rows.map(row => row.id + '  ' + row.kind + '  ' + row.title + '  ' + row.scheduledAt).join(NL))
          } catch (error) {
            pushNotice('error', 'Could not list reminders: ' + errorMessage(error))
          }
          return
        }
        const parts = args.split(/\s+/u)
        const subcommand = parts[0] ?? ''
        const rest = args.slice(subcommand.length).trim()
        if (subcommand === 'add') {
          const firstSpace = rest.indexOf(' ')
          const secondsText = firstSpace === -1 ? rest : rest.slice(0, firstSpace)
          const title = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()
          const seconds = Number(secondsText)
          if (!Number.isSafeInteger(seconds) || seconds < 1 || title === '') {
            pushNotice('warning', 'Usage: /schedule add <seconds> <title>')
            return
          }
          try {
            const created = await scheduleService.create(active.id, {
              title,
              prompt: title,
              after_seconds: seconds,
            })
            pushNotice('info', 'Reminder created: ' + created.id + '  ' + created.scheduledAt)
          } catch (error) {
            pushNotice('error', 'Could not create reminder: ' + errorMessage(error))
          }
          return
        }
        if (subcommand === 'delete') {
          if (rest === '') {
            pushNotice('warning', 'Usage: /schedule delete <id>')
            return
          }
          try {
            const result = await scheduleService.delete({ sessionId: active.id, id: rest })
            pushNotice('info', 'Reminder delete: ' + JSON.stringify(result))
          } catch (error) {
            pushNotice('error', 'Could not delete reminder: ' + errorMessage(error))
          }
          return
        }
        pushNotice('warning', 'Usage: /schedule [add <seconds> <title> | delete <id>]')
        return
      }
      case 'plugins': {
        const manager = host.get('pluginManager') as unknown as PluginManagerService | undefined
        if (manager === undefined) {
          pushNotice('warning', 'The plugin manager is unavailable in this profile.')
          return
        }
        if (args === '') {
          try {
            const bundles = await manager.listBundles()
            if (bundles.length === 0) {
              pushNotice('info', 'No bundles reported.')
              return
            }
            pushNotice('info', 'Bundles (read-only; use dsh plugin or Web to change):' + NL + bundles.map(bundle => {
              const state = bundle.enabled ? '[on] ' : '[off] '
              return state + bundle.name + (bundle.version === undefined ? '' : '  ' + bundle.version)
                + (bundle.installed ? '' : '  (not installed)')
            }).join(NL) + NL + 'Use /plugins list for plugin entries; /plugins enable|disable <entryId> to change one.')
          } catch (error) {
            pushNotice('error', 'Could not list bundles: ' + errorMessage(error))
          }
          return
        }
        if (args === 'list' || args.startsWith('list ')) {
          try {
            const query = args.startsWith('list ') ? args.slice('list '.length).trim().toLowerCase() : ''
            const allRows = await manager.listPlugins()
            const rows = query === '' ? allRows : allRows.filter(row => row.entryId.toLowerCase().includes(query) || row.moduleName.toLowerCase().includes(query))
            if (rows.length === 0) {
              pushNotice('info', 'No plugin entries reported.')
              return
            }
            pushNotice('info', 'Plugin entries' + (query === '' ? ' (first 40)' : ' matching "' + query + '"') + ':' + NL + rows.slice(0, 40).map(row => {
              const state = row.enabled ? '[on] ' : '[off] '
              const readOnly = row.readOnlyReason === undefined ? '' : '  (read-only: ' + row.readOnlyReason + ')'
              return state + row.entryId + '  ' + row.moduleName + readOnly
            }).join(NL) + (rows.length > 40 ? NL + '… ' + String(rows.length - 40) + ' more' : '') + NL
              + 'Use /plugins enable|disable <entryId>; the app may reload.')
          } catch (error) {
            pushNotice('error', 'Could not list plugin entries: ' + errorMessage(error))
          }
          return
        }
        if (args === 'market' || args.startsWith('market ')) {
          const query = args.slice('market'.length).trim().toLowerCase()
          try {
            const bundles = await manager.listBundles()
            const rows = bundles.filter(bundle => bundle.installTarget !== undefined).filter(bundle =>
              query === ''
              || bundle.name.toLowerCase().includes(query)
              || (bundle.description ?? '').toLowerCase().includes(query))
            if (rows.length === 0) {
              pushNotice('info', query === '' ? 'The official market has no on-demand bundles.' : 'No market bundle matches "' + query + '".')
              return
            }
            pushNotice('info', 'Official market (on-demand):' + NL + rows.map(bundle => {
              const state = bundle.installed ? (bundle.enabled ? '[on] ' : '[off] ') : '[available] '
              const target = bundle.installTarget
              return state + bundle.name + (bundle.version === undefined ? '' : '  ' + bundle.version)
                + (bundle.description === undefined ? '' : NL + '  ' + bundle.description.slice(0, 140))
                + (target === undefined || bundle.installed ? '' : NL + '  install: /plugins install ' + target.spec)
            }).join(NL))
          } catch (error) {
            pushNotice('error', 'Could not read the plugin market: ' + errorMessage(error))
          }
          return
        }
        if (args.startsWith('inspect ')) {
          const spec = args.slice('inspect '.length).trim()
          if (spec === '') {
            pushNotice('warning', 'Usage: /plugins inspect <spec>')
            return
          }
          pushNotice('info', 'Inspecting ' + spec + '…')
          try {
            const preview = await manager.inspect(spec)
            if (preview.status === 'refused') {
              pushNotice('warning', 'Refused: ' + (preview.problem ?? 'unknown') + (preview.reason === undefined ? '' : ' · ' + preview.reason))
              return
            }
            pushNotice('info', 'Accepted: ' + (preview.name ?? spec)
              + (preview.version === undefined ? '' : '@' + preview.version)
              + ' · ' + (preview.kind ?? 'unknown')
              + (preview.bundle === false ? ' · no bundle patch' : '')
              + (preview.description === undefined ? '' : NL + preview.description))
          } catch (error) {
            pushNotice('error', 'Could not inspect ' + spec + ': ' + errorMessage(error))
          }
          return
        }
        if (args.startsWith('install ')) {
          const spec = args.slice('install '.length).trim()
          if (spec === '') {
            pushNotice('warning', 'Usage: /plugins install <spec>')
            return
          }
          pushNotice('info', 'Inspecting ' + spec + '…')
          try {
            const preview = await manager.inspect(spec)
            if (preview.status === 'refused') {
              pushNotice('warning', 'Refused: ' + (preview.problem ?? 'unknown') + (preview.reason === undefined ? '' : ' · ' + preview.reason))
              return
            }
            const label = preview.name ?? spec
            const confirmed = await showChoice(
              tui,
              palette,
              'Install ' + label + '?',
              [
                { value: 'yes', label: 'Continue', description: 'pnpm installs the package; the profile may reload' },
                { value: 'no', label: 'Cancel' },
              ],
              'Enter selects · Esc cancels',
              interactionAbort.signal,
            )
            if (confirmed !== 'yes') return
            pushNotice('info', 'Installing ' + label + '… pnpm may take a while.')
            const result = await manager.installBundle(spec, { enabled: true })
            const suffix = result.error === undefined
              ? ' · ' + result.application
              : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
            pushNotice(result.error === undefined ? 'info' : 'error', 'install ' + label + suffix)
          } catch (error) {
            pushNotice('error', 'Could not install ' + spec + ': ' + errorMessage(error))
          }
          return
        }
        if (args.startsWith('remove ')) {
          const name = args.slice('remove '.length).trim()
          if (name === '') {
            pushNotice('warning', 'Usage: /plugins remove <bundleName>')
            return
          }
          try {
            const bundle = (await manager.listBundles()).find(item => item.name === name)
            if (bundle === undefined) {
              pushNotice('warning', 'Unknown bundle "' + name + '".')
              return
            }
            if (bundle.removable === false) {
              pushNotice('warning', 'Bundle "' + name + '" is not removable in this profile.')
              return
            }
            const confirmed = await showChoice(
              tui,
              palette,
              'Remove ' + name + '?',
              [
                { value: 'yes', label: 'Continue', description: 'pnpm removes the dependency and the profile may reload' },
                { value: 'no', label: 'Cancel' },
              ],
              'Enter selects · Esc cancels',
              interactionAbort.signal,
            )
            if (confirmed !== 'yes') return
            pushNotice('info', 'Removing ' + name + '… pnpm may take a while.')
            const result = await manager.removeBundle(name)
            const suffix = result.error === undefined
              ? ' · ' + result.application
              : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
            pushNotice(result.error === undefined ? 'info' : 'error', 'remove ' + name + suffix)
          } catch (error) {
            pushNotice('error', 'Could not remove ' + name + ': ' + errorMessage(error))
          }
          return
        }
        if (args.startsWith('enable ') || args.startsWith('disable ')) {
          const verb = args.startsWith('enable ') ? 'enable' : 'disable'
          const id = args.slice(verb.length).trim()
          if (id === '') {
            pushNotice('warning', 'Usage: /plugins ' + verb + ' <entryId>')
            return
          }
          try {
            const row = (await manager.listPlugins()).find(item => item.entryId === id)
            if (row === undefined) {
              pushNotice('warning', 'Unknown plugin entry "' + id + '". Use /plugins list.')
              return
            }
            if (row.readOnlyReason !== undefined) {
              pushNotice('warning', 'Plugin entry "' + id + '" is read-only: ' + row.readOnlyReason)
              return
            }
            const confirmed = await showChoice(
              tui,
              palette,
              verb + ' plugin ' + id + '?',
              [
                { value: 'yes', label: 'Continue', description: 'The profile may reload and interrupt this terminal' },
                { value: 'no', label: 'Cancel' },
              ],
              'Enter selects · Esc cancels',
              interactionAbort.signal,
            )
            if (confirmed !== 'yes') return
            const result = await manager.setPluginEnabled(id, verb === 'enable')
            const suffix = result.error === undefined
              ? ' · ' + result.application
              : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
            pushNotice(result.error === undefined ? 'info' : 'error', verb + ' ' + id + suffix)
          } catch (error) {
            pushNotice('error', 'Could not ' + verb + ' plugin: ' + errorMessage(error))
          }
          return
        }
        pushNotice('warning', 'Usage: /plugins [list | market [query] | inspect <spec> | install <spec> | remove <bundle> | enable <entryId> | disable <entryId>]')
        return
      }
      case 'settings': {
        const settings = host.get('settings') as unknown as SettingsService | undefined
        if (settings === undefined) {
          pushNotice('warning', 'The settings service is unavailable in this profile.')
          return
        }
        try {
          if (args === 'edit' || args.startsWith('edit ')) {
            const nsArg = args.slice('edit'.length).trim()
            const descriptors = settings.describe({ redactSecrets: true })
            let descriptor = nsArg === '' ? undefined : descriptors.find(row => row.ns === nsArg)
            if (nsArg !== '' && descriptor === undefined) {
              pushNotice('warning', 'No active settings namespace "' + nsArg + '".')
              return
            }
            if (descriptor === undefined) {
              const namespaceChoice = await showChoice(
                tui,
                palette,
                'Settings namespace',
                descriptors.map(row => ({
                  value: row.ns,
                  label: row.ns,
                  description: Object.keys(row.value).join(', '),
                })),
                'Enter selects · Esc cancels',
                interactionAbort.signal,
              )
              if (namespaceChoice === undefined) return
              descriptor = descriptors.find(row => row.ns === namespaceChoice)
            }
            if (descriptor === undefined) return
            const fields = settingsFields(descriptor.schema)
            if (fields.length === 0) {
              pushNotice('warning', 'Namespace "' + descriptor.ns + '" exposes no editable live fields.')
              return
            }
            const field = await showChoice(
              tui,
              palette,
              'Settings · ' + descriptor.ns,
              fields.map(name => ({
                value: name,
                label: name,
                description: JSON.stringify(descriptor!.value[name] ?? null).slice(0, 120),
              })),
              'Enter selects · Esc cancels',
              interactionAbort.signal,
            )
            if (field === undefined) return
            const path: string[] = [field]
            while (path.length < 4) {
              const children = settingsChildFields(descriptor.schema, path)
              if (children.length === 0) break
              const nested = await showChoice(
                tui,
                palette,
                'Settings · ' + descriptor.ns + '.' + path.join('.'),
                [
                  { value: '__json__', label: 'Edit this object as JSON', description: 'Replace the whole object' },
                  ...children.map(name => ({
                    value: name,
                    label: name,
                    description: JSON.stringify(settingsValueAt(descriptor!.value, [...path, name]) ?? null).slice(0, 120),
                  })),
                ],
                'Enter selects · Esc cancels',
                interactionAbort.signal,
              )
              if (nested === undefined) return
              if (nested === '__json__') break
              path.push(nested)
            }
            if (descriptor.secrets?.some(secret => path.every((part, index) => secret.path[index] === part)) === true) {
              pushNotice('warning', 'Field "' + path.join('.') + '" is secret; use the Web Models page instead of terminal history.')
              return
            }
            const dotted = path.join('.')
            const current = settingsValueAt(descriptor.value, path)
            const raw = await showTextInput(
              tui,
              palette,
              'Set ' + descriptor.ns + '.' + dotted,
              'JSON value (current: ' + JSON.stringify(current ?? null).slice(0, 80) + ')',
              'Enter writes · Esc cancels',
              interactionAbort.signal,
            )
            if (raw === undefined) return
            let value: unknown
            try {
              value = JSON.parse(raw)
            } catch (error) {
              pushNotice('error', 'Invalid JSON: ' + errorMessage(error))
              return
            }
                        try {
                            let patch;
                            if (path.length === 1) {
                                patch = { [field]: value };
                            }
                            else {
                                const top = descriptor.value[field];
                                let root;
                                try {
                                    root = structuredClone(top);
                                }
                                catch {
                                    root = top === undefined ? {} : JSON.parse(JSON.stringify(top));
                                }
                                root = settingsSetAt(root, path.slice(1), value);
                                patch = { [field]: root };
                            }
                            await settings.update(descriptor.ns, patch, descriptor.revision);
                            pushNotice('info', 'Updated ' + descriptor.ns + '.' + dotted);
                        }
                        catch (error) {
                            pushNotice('error', 'Could not update settings: ' + errorMessage(error));
                        }
                        return;
                    }
                    if (args.startsWith('items ')) {
                        const rest = args.slice('items '.length).trim();
                        const [ns, field] = rest.split(/\s+/u);
                        if (ns === undefined || field === undefined) {
                            pushNotice('warning', 'Usage: /settings items <namespace> <array-field>');
                            return;
                        }
                        const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === ns);
                        if (descriptor === undefined) {
                            pushNotice('warning', 'No active settings namespace "' + ns + '".');
                            return;
                        }
                        const current = descriptor.value[field];
                        if (!Array.isArray(current)) {
                            pushNotice('warning', 'Settings field "' + ns + '.' + field + '" is not an array.');
                            return;
                        }
                        const picked = await showChoice(tui, palette, 'Array · ' + ns + '.' + field, [
                            ...current.map((item, index) => ({
                                value: String(index),
                                label: String(index) + '. ' + JSON.stringify(item ?? null).slice(0, 100),
                                description: 'array item',
                            })),
                            { value: '__append__', label: '+ Append JSON item', description: 'Add one item to the end' },
                        ], 'Enter selects · Esc cancels', interactionAbort.signal);
                        if (picked === undefined)
                            return;
                        let array;
                        try {
                            array = structuredClone(current);
                        }
                        catch {
                            array = JSON.parse(JSON.stringify(current));
                        }
                        if (picked === '__append__') {
                            const raw = await showTextInput(tui, palette, 'Append ' + ns + '.' + field, 'JSON value', 'Enter writes · Esc cancels', interactionAbort.signal);
                            if (raw === undefined)
                                return;
                            try {
                                array.push(JSON.parse(raw));
                            }
                            catch (error) {
                                pushNotice('error', 'Invalid JSON: ' + errorMessage(error));
                                return;
                            }
                        }
                        else {
                            const index = Number(picked);
                            if (!Number.isSafeInteger(index) || index < 0 || index >= array.length) {
                                pushNotice('warning', 'No array item at index ' + picked + '.');
                                return;
                            }
                            const action = await showChoice(tui, palette, 'Item ' + String(index) + ' · ' + ns + '.' + field, [
                                { value: 'edit', label: 'Edit JSON', description: 'Replace this item' },
                                { value: 'remove', label: 'Remove', description: 'Delete this item' },
                                { value: 'back', label: 'Back' },
                            ], 'Enter selects · Esc cancels', interactionAbort.signal);
                            if (action === 'remove') {
                                array.splice(index, 1);
                            }
                            else if (action === 'edit') {
                                const raw = await showTextInput(tui, palette, 'Set item ' + String(index) + ' · ' + ns + '.' + field, 'JSON value (current: ' + JSON.stringify(array[index] ?? null).slice(0, 80) + ')', 'Enter writes · Esc cancels', interactionAbort.signal);
                                if (raw === undefined)
                                    return;
                                try {
                                    array[index] = JSON.parse(raw);
                                }
                                catch (error) {
                                    pushNotice('error', 'Invalid JSON: ' + errorMessage(error));
                                    return;
                                }
                            }
                            else {
                                return;
                            }
                        }
                        try {
                            await settings.update(ns, { [field]: array }, descriptor.revision);
                            pushNotice('info', 'Updated array ' + ns + '.' + field + ' (' + String(array.length) + ' items)');
                        }
                        catch (error) {
                            pushNotice('error', 'Could not update settings array: ' + errorMessage(error));
                        }
                        return;
                    }
                    if (args.startsWith('set ')) {
                        const rest = args.slice('set '.length).trim();
                        const space = rest.indexOf(' ');
                        const ns = space === -1 ? rest : rest.slice(0, space);
                        const json = space === -1 ? '' : rest.slice(space + 1).trim();
                        if (ns === '' || json === '') {
                            pushNotice('warning', 'Usage: /settings set <namespace> <json-object>');
                            return;
                        }
                        let patch;
                        try {
                            patch = JSON.parse(json);
                        }
                        catch (error) {
                            pushNotice('error', 'Invalid JSON: ' + errorMessage(error));
                            return;
                        }
                        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                            pushNotice('warning', 'Settings patch must be a JSON object.');
                            return;
                        }
                        const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === ns);
                        if (descriptor === undefined) {
                            pushNotice('warning', 'No active settings namespace "' + ns + '".');
                            return;
                        }
                        if (descriptor.secrets !== undefined && descriptor.secrets.length > 0) {
                            pushNotice('warning', 'This namespace has secret fields; prefer the Web Models page for credentials. Writing non-secret fields now.');
                        }
                        await settings.update(ns, patch, descriptor.revision);
                        pushNotice('info', 'Settings updated: ' + ns + ' (live where the owner applies immediately)');
                        return;
                    }
                    const descriptors = settings.describe({ redactSecrets: true });
                    if (descriptors.length === 0) {
                        pushNotice('info', 'No configurable plugin namespaces are active.');
                        return;
                    }
                    pushNotice('info', 'Settings namespaces (read-only unless using /settings set):' + NL + descriptors.map(descriptor => {
                        const keys = Object.keys(descriptor.value);
                        return descriptor.ns + (keys.length === 0 ? '' : '  ' + keys.join(', '));
                    }).join(NL));
                }
                catch (error) {
                    pushNotice('error', 'Could not read/write settings: ' + errorMessage(error));
                }
                return;
            }
            case 'preset': {
                const presetService = host.get('agentPresets') as AgentPresetService | undefined;
                if (presetService === undefined) {
                    pushNotice('warning', 'The agent-preset registry is unavailable.');
                    return;
                }
                try {
                    const rows = await presetService.list();
                    const currentPreset = presetService.composedPreset(active.agent.ctx);
                    const applyPreset = async (id: string): Promise<void> => {
                        selectedPreset = id;
                        try {
                            const applied = await presetService.select(active.agent, id);
                            selectedPreset = applied;
                            pushNotice('info', 'Agent preset for current session: ' + applied);
                            renderStatus();
                        }
                        catch (error) {
                            pushNotice('warning', 'Current session cannot switch preset: ' + errorMessage(error)
                                + ' — next /new will use ' + id + '.');
                        }
                        const settings = host.get('settings') as unknown as SettingsService | undefined;
                        if (settings === undefined) {
                            pushNotice('warning', 'Preset applies now, but the settings service is unavailable; default preset was not saved.');
                            return;
                        }
                        try {
                            const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'agent-preset-registry');
                            await settings.update('agent-preset-registry', { selectedDefault: id }, descriptor?.revision);
                            pushNotice('info', 'Default preset saved: ' + id);
                        }
                        catch (error) {
                            pushNotice('warning', 'Preset applies now, but the default could not be saved: ' + errorMessage(error));
                        }
                    };
                    if (args === '') {
                        const choice = await showChoice(tui, palette, 'Agent preset (current: ' + (currentPreset ?? 'none') + ')', rows.map((row: { id: string; name?: string; description?: string }) => ({
                            value: row.id,
                            label: (row.id === currentPreset ? '* ' : row.id === selectedPreset ? '+ ' : '  ') + row.id,
                            description: (row.name ?? '') + (row.description === undefined ? '' : ' — ' + row.description),
                        })), 'Enter applies to a blank current session; started sessions use next /new · Esc cancels', interactionAbort.signal);
                        if (choice !== undefined) {
                            await applyPreset(choice);
                        }
                        return;
                    }
                    if (!rows.some((row: { id: string }) => row.id === args)) {
                        pushNotice('warning', 'Unknown preset "' + args + '". Available: ' + rows.map((row: { id: string }) => row.id).join(', '));
                        return;
                    }
                    await applyPreset(args);
                }
                catch (error) {
                    pushNotice('error', 'Could not read presets: ' + errorMessage(error));
                }
                return;
            }
            case 'export': {
                if (args === 'html' || args.startsWith('html ')) {
                    const target = args === 'html'
                        ? 'dsh-session-' + active.id + '.html'
                        : args.slice('html '.length).trim();
                    if (target === '') {
                        pushNotice('warning', 'Usage: /export html [path]');
                        return;
                    }
                    try {
                        const result = await exportSessionHtml(active.agent, target, config.cwd);
                        pushNotice('info', 'Exported HTML: ' + result.path + ' (' + String(result.bytes) + ' bytes, ' + String(result.eventCount) + ' events)');
                    }
                    catch (error) {
                        pushNotice('error', 'HTML export failed: ' + errorMessage(error));
                    }
                    return;
                }
                if (args === 'zip' || args.startsWith('zip ')) {
                    const target = args === 'zip'
                        ? 'dsh-session-' + active.id + '.zip'
                        : args.slice('zip '.length).trim();
                    if (target === '') {
                        pushNotice('warning', 'Usage: /export zip [path]');
                        return;
                    }
                    const attachments = host.get('attachments') as AttachmentsService | undefined;
                    if (attachments === undefined) {
                        pushNotice('warning', 'The attachment service is unavailable; cannot build a ZIP bundle.');
                        return;
                    }
                    try {
                        const result = await exportSessionBundle(active.agent, target, config.cwd, attachments, interactionAbort.signal);
                        pushNotice('info', 'Exported ZIP bundle: ' + result.path + ' (' + String(result.bytes) + ' bytes, '
                            + String(result.attachments.length) + ' attachment(s), '
                            + String(result.deliverables.length) + ' deliverable(s)'
                            + (result.skipped.length === 0 ? '' : ', ' + String(result.skipped.length) + ' skipped') + ')');
                    }
                    catch (error) {
                        pushNotice('error', 'ZIP export failed: ' + errorMessage(error));
                    }
                    return;
                }
                const target = args === '' ? 'dsh-session-' + active.id + '.jsonl' : args;
                try {
                    const result = await exportSessionLog(active.agent, target, config.cwd);
                    pushNotice('info', 'Exported ' + String(result.eventCount) + ' events to ' + result.path);
                }
                catch (error) {
                    pushNotice('error', 'Export failed: ' + errorMessage(error));
                }
                return;
            }
            case 'open': {
                if (args === '') {
                    pushNotice('warning', 'Usage: /open <path>');
                    return;
                }
                try {
                    const target = resolve(config.cwd, args);
                    const preview = await readTextPreview(target);
                    if (isMarkdownPath(target)) {
                        await showMarkdownPreview(tui, palette, preview.path, preview.text, interactionAbort.signal);
                        return;
                    }
                    pushNotice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
                        + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text);
                }
                catch (error) {
                    pushNotice('error', 'Could not open ' + args + ': ' + errorMessage(error));
                }
                return;
            }
            case 'attach': {
                const attachments = host.get('attachments');
                if (attachments === undefined) {
                    pushNotice('warning', 'The attachment service is unavailable in this profile.');
                    return;
                }
                if (args === 'paste') {
                    const clipboard = getNativeClipboard();
                    if (clipboard === undefined) {
                        pushNotice('warning', 'Clipboard images are unavailable on this platform.');
                        return;
                    }
                    try {
                        const image = await clipboard.getImage();
                        if (image === undefined) {
                            pushNotice('warning', 'The system clipboard image reader is unavailable.');
                            return;
                        }
                        if (image === null) {
                            pushNotice('info', 'No image on the clipboard.');
                            return;
                        }
                        if (image.byteLength > MAX_ATTACHMENT_BYTES) {
                            pushNotice('warning', 'Clipboard image is ' + String(image.byteLength) + ' bytes; terminal attachment limit is ' + String(MAX_ATTACHMENT_BYTES) + '.');
                            return;
                        }
                        const mediaType = detectImageMediaType(image);
                        if (mediaType === undefined) {
                            pushNotice('warning', 'Clipboard image is not PNG, JPEG, GIF, or WebP.');
                            return;
                        }
                        const name = 'clipboard' + imageExtension(mediaType);
                        const refs = await attachments.saveImages([{ data: image, mediaType, name }]);
                        const ref = refs[0];
                        if (ref === undefined)
                            throw new Error('attachment service returned no image reference');
                        pendingAttachments.push({
                            label: name,
                            kind: 'image',
                            block: { type: 'image', attachment: ref },
                        });
                        pushNotice('info', 'Attached clipboard image: ' + name + ' (sent with the next prompt)');
                        renderStatus();
                    }
                    catch (error) {
                        pushNotice('error', 'Could not read the clipboard image: ' + errorMessage(error));
                    }
                    return;
                }
                if (args.startsWith('preview ')) {
                    const index = Number(args.slice('preview '.length).trim());
                    if (!Number.isSafeInteger(index) || index < 0 || pendingAttachments[index] === undefined) {
                        pushNotice('warning', 'Usage: /attach preview <index> (see /attach list)');
                        return;
                    }
                    const pending = pendingAttachments[index];
                    try {
                        if (pending.block.type === 'image') {
                            const stored = await attachments.readImage(pending.block.attachment, interactionAbort.signal);
                            await showImagePreview(tui, palette, {
                                path: 'attachment://' + pending.block.attachment.attachmentId,
                                name: pending.label,
                                mediaType: pending.block.attachment.mediaType,
                                base64: Buffer.from(stored.data).toString('base64'),
                                bytes: stored.data.byteLength,
                            }, interactionAbort.signal);
                        }
                        else if (pending.block.type === 'file') {
                            const chunks = [];
                            let total = 0;
                            for await (const chunk of attachments.readFileStream(pending.block.attachment, interactionAbort.signal)) {
                                const remaining = 65_536 - total;
                                if (remaining <= 0)
                                    break;
                                const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
                                chunks.push(part);
                                total += part.byteLength;
                                if (total >= 65_536)
                                    break;
                            }
                            const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
                            if (data.includes(0)) {
                                pushNotice('info', 'File: ' + pending.label + ' (' + String(data.byteLength) + ' bytes, binary)');
                            }
                            else {
                                pushNotice('info', 'File: ' + pending.label + ' (' + String(total) + ' bytes'
                                    + (total >= 65_536 ? ', truncated' : '') + ')' + NL + sanitizeTerminalText(new TextDecoder().decode(data)));
                            }
                        }
                        else {
                            pushNotice('warning', 'Attachment ' + String(index) + ' has no previewable block.');
                        }
                    }
                    catch (error) {
                        pushNotice('error', 'Could not preview attachment ' + String(index) + ': ' + errorMessage(error));
                    }
                    return;
                }
                if (args === '' || args === 'list') {
                    if (pendingAttachments.length === 0) {
                        pushNotice('info', 'No staged attachments. Use /attach <path>, /attach paste, or /attach clear.');
                        return;
                    }
                    pushNotice('info', 'Staged attachments:' + NL + pendingAttachments.map((item, index) => String(index) + '. ' + item.kind + '  ' + item.label).join(NL)
                        + NL + 'Use /attach preview <index> to inspect one.');
                    return;
                }
                if (args === 'clear') {
                    const count = pendingAttachments.length;
                    pendingAttachments = [];
                    pushNotice('info', 'Cleared ' + String(count) + ' staged attachment(s).');
                    renderStatus();
                    return;
                }
                try {
                    const pending = await loadAttachment(args, config.cwd, attachments);
                    pendingAttachments.push(pending);
                    pushNotice('info', 'Attached ' + pending.kind + ': ' + pending.label + ' (sent with the next prompt)');
                    renderStatus();
                }
                catch (error) {
                    pushNotice('error', 'Could not attach ' + args + ': ' + errorMessage(error));
                }
                return;
            }
            case 'files': {
                let current = resolve(config.cwd, args === '' ? '.' : args);
                for (;;) {
                    let entries;
                    try {
                        entries = await listDirectory(current);
                    }
                    catch (error) {
                        pushNotice('error', 'Could not list ' + current + ': ' + errorMessage(error));
                        return;
                    }
                    const parent = dirname(current);
                    const items = [
                        ...(parent === current ? [] : [{ value: '__parent__', label: '../', description: 'parent directory' }]),
                        ...entries.map(entry => ({
                            value: entry.path,
                            label: entry.kind === 'directory' ? entry.name + '/' : entry.name,
                            description: entry.kind,
                        })),
                    ];
                    if (items.length === 0) {
                        pushNotice('info', 'Directory is empty: ' + current);
                        return;
                    }
                    const picked = await showChoice(tui, palette, 'Files · ' + current, items, 'Enter opens · Esc exits', interactionAbort.signal);
                    if (picked === undefined)
                        return;
                    if (picked === '__parent__') {
                        current = parent;
                        continue;
                    }
                    const entry = entries.find(candidate => candidate.path === picked);
                    if (entry === undefined)
                        return;
                    if (entry.kind === 'directory') {
                        current = entry.path;
                        continue;
                    }
                    try {
                        const preview = await readTextPreview(entry.path);
                        pushNotice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
                            + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text);
                    }
                    catch (error) {
                        pushNotice('error', 'Could not open ' + entry.path + ': ' + errorMessage(error));
                    }
                    return;
                }
            }
            case 'changes': {
                const changes = host.get('workspaceChanges');
                if (changes === undefined) {
                    pushNotice('warning', 'The workspace-changes service is unavailable in this profile.');
                    return;
                }
                const latest = active.agent.session.snapshotEvents()
                    .filter(event => (event.type as string) === 'workspace/changes')
                    .at(-1) as unknown as { readonly seq: number } | undefined;
                if (latest === undefined) {
                    pushNotice('info', 'No workspace-change summary recorded for this session yet.');
                    return;
                }
                const seq = Number(latest.seq);
                if (args.startsWith('diff ')) {
                    const index = Number(args.slice('diff '.length).trim());
                    if (!Number.isSafeInteger(index) || index < 0) {
                        pushNotice('warning', 'Usage: /changes diff <file-index>');
                        return;
                    }
                    try {
                        const diff = await changes.diff(active.id, seq, index, interactionAbort.signal);
                        if (diff === undefined) {
                            pushNotice('warning', 'No comparison is available for file ' + String(index) + '.');
                            return;
                        }
                        pushNotice('info', formatWorkspaceDiff(diff));
                    }
                    catch (error) {
                        pushNotice('error', 'Could not read the file diff: ' + errorMessage(error));
                    }
                    return;
                }
                const summary = changes.summary(active.id, seq);
                if (summary === undefined) {
                    pushNotice('warning', 'The latest change summary is no longer available in this process.');
                    return;
                }
                pushNotice('info', formatChangesSummary(summary) + NL + 'Use /changes diff <index> for one file.');
                return;
            }
            case 'deliverables': {
                const events = active.agent.session.snapshotEvents()
                    .filter(event => (event.type as string) === 'deliverables/presented')
                    .map(event => event.data as { readonly turn: number; readonly files: readonly PresentedFileView[] });
                if (events.length === 0) {
                    pushNotice('info', 'No presented deliverables in this session yet.');
                    return;
                }
                if (args === 'panel') {
                    const rows = collectDeliverables(events);
                    const picked = await showChoice(tui, palette, 'Deliverables', rows.map((row, index) => ({
                        value: String(index),
                        label: String(index) + '. ' + row.path,
                        description: (row.description ?? 'turn ' + String(row.turn)),
                    })), 'Enter selects · Esc closes', interactionAbort.signal);
                    if (picked === undefined)
                        return;
                    const index = Number(picked);
                    const target = rows[index];
                    if (target === undefined)
                        return;
                    const action = await showChoice(tui, palette, 'Deliverable · ' + target.path, [
                        { value: 'open', label: 'Preview', description: 'Render text or Markdown in the transcript/overlay' },
                        { value: 'reveal', label: 'Reveal', description: 'Open the system file manager at this file' },
                        { value: 'back', label: 'Back' },
                    ], 'Enter selects · Esc closes', interactionAbort.signal);
                    if (action === 'open') {
                        await runCommand('/deliverables open ' + String(index));
                    }
                    else if (action === 'reveal') {
                        await runCommand('/deliverables reveal ' + String(index));
                    }
                    return;
                }
                if (args.startsWith('reveal ')) {
                    const index = Number(args.slice('reveal '.length).trim());
                    if (!Number.isSafeInteger(index) || index < 0) {
                        pushNotice('warning', 'Usage: /deliverables reveal <index>');
                        return;
                    }
                    const target = collectDeliverables(events)[index];
                    if (target === undefined) {
                        pushNotice('warning', 'No presented deliverable at index ' + String(index) + '.');
                        return;
                    }
                    if (systemRevealCommand(process.platform, target.path) === undefined) {
                        pushNotice('warning', 'Revealing files is unsupported on this platform.');
                        return;
                    }
                    const confirmed = await showChoice(tui, palette, 'Reveal ' + target.path + '?', [
                        { value: 'yes', label: 'Continue', description: 'Open the system file manager at this path' },
                        { value: 'no', label: 'Cancel' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (confirmed !== 'yes')
                        return;
                    if (revealWithSystemApp(target.path))
                        pushNotice('info', 'Revealed ' + target.path + ' in the system file manager.');
                    else
                        pushNotice('error', 'Could not launch the system file manager for ' + target.path + '.');
                    return;
                }
                if (args.startsWith('open ')) {
                    const index = Number(args.slice('open '.length).trim());
                    if (!Number.isSafeInteger(index) || index < 0) {
                        pushNotice('warning', 'Usage: /deliverables open <index>');
                        return;
                    }
                    const target = collectDeliverables(events)[index];
                    if (target === undefined) {
                        pushNotice('warning', 'No presented deliverable at index ' + String(index) + '.');
                        return;
                    }
                    try {
                        const preview = await readTextPreview(target.path);
                        pushNotice('info', 'File: ' + preview.path + ' (' + String(preview.bytes) + ' bytes'
                            + (preview.truncated ? ', truncated' : '') + ')' + NL + preview.text);
                    }
                    catch (error) {
                        pushNotice('error', 'Could not open ' + target.path + ': ' + errorMessage(error));
                    }
                    return;
                }
                pushNotice('info', formatDeliverables(events));
                return;
            }
            case 'preview': {
                if (args === '') {
                    pushNotice('warning', 'Usage: /preview <image-path>');
                    return;
                }
                try {
                    const image = await readImagePreview(resolve(config.cwd, args));
                    await showImagePreview(tui, palette, image, interactionAbort.signal);
                }
                catch (error) {
                    pushNotice('error', 'Could not preview ' + args + ': ' + errorMessage(error));
                }
                return;
            }
            case 'tools': {
                const calls = collectToolCalls(active.agent.session.snapshotEvents(), 20);
                if (calls.length === 0) {
                    pushNotice('info', 'No tool calls recorded in this session yet.');
                    return;
                }
                pushNotice('info', 'Tool calls:' + NL + calls.map((call, index) => String(index) + '. ' + call.name
                    + (call.isError === true ? '  error' : call.result === undefined ? '  pending' : '  ok')).join(NL)
                    + NL + 'Use /tool <index> to page the full arguments and result.');
                return;
            }
            case 'tool': {
                if (args === '') {
                    pushNotice('warning', 'Usage: /tool <index> (see /tools)');
                    return;
                }
                const index = Number(args);
                if (!Number.isSafeInteger(index) || index < 0) {
                    pushNotice('warning', 'Usage: /tool <index> (see /tools)');
                    return;
                }
                const call = collectToolCalls(active.agent.session.snapshotEvents(), 20)[index];
                if (call === undefined) {
                    pushNotice('warning', 'No tool call at index ' + String(index) + '.');
                    return;
                }
                let formattedArgs = call.args;
                try {
                    formattedArgs = JSON.stringify(JSON.parse(call.args), null, 2);
                }
                catch {
                    // Keep the recorded text when arguments are not JSON.
                }
                const text = call.name + ' · ' + call.callId + ' · ' + (call.isError === true ? 'error' : 'ok')
                    + NL + NL + 'Arguments:' + NL + formattedArgs
                    + NL + NL + 'Result:' + NL + (call.result === undefined ? '(pending)' : call.result);
                await showTextPager(tui, palette, 'Tool · ' + call.name, text, interactionAbort.signal);
                return;
            }
            case 'diff': {
                const calls = collectToolCalls(active.agent.session.snapshotEvents(), 50);
                const withDiffs = calls
                    .map((call, index) => ({ call, index }))
                    .filter(item => item.call.diffs !== undefined && item.call.diffs.length > 0);
                if (withDiffs.length === 0) {
                    pushNotice('info', 'No file diffs recorded in this session yet.');
                    return;
                }
                let entry = withDiffs.at(-1);
                if (args !== '') {
                    const index = Number(args);
                    if (!Number.isSafeInteger(index) || index < 0) {
                        pushNotice('warning', 'Usage: /diff [tool-index]');
                        return;
                    }
                    entry = withDiffs.find(item => item.index === index);
                    if (entry === undefined) {
                        pushNotice('warning', 'No tool diff at index ' + String(index) + '. Use /tools to list calls.');
                        return;
                    }
                }
                if (entry === undefined)
                    return;
                const lines = [palette.bold('Diff · ' + entry.call.name + ' · ' + entry.call.callId)];
                for (const diff of entry.call.diffs ?? []) {
                    lines.push(palette.bold(palette.accent('diff ' + diff.path)));
                    for (const row of diffLines(diff.oldText, diff.newText, 120)) {
                        lines.push(row.kind === 'add'
                            ? palette.success('+ ' + row.text)
                            : row.kind === 'remove' ? palette.error('- ' + row.text) : palette.dim('  ' + row.text));
                    }
                }
                await showTextPager(tui, palette, 'Diff · ' + entry.call.name, lines.join('\n'), interactionAbort.signal);
                return;
            }
            case 'attachments': {
                if (pendingAttachments.length === 0) {
                    pushNotice('info', 'No staged attachments. Use /attach <path> or /attach paste to add one.');
                    return;
                }
                const picked = await showChoice(tui, palette, 'Attachments', pendingAttachments.map((item, index) => ({
                    value: String(index),
                    label: String(index) + '. ' + item.label,
                    description: item.kind + (item.kind === 'image' ? ' · image preview available' : ' · text preview available'),
                })), 'Enter opens · Esc closes', interactionAbort.signal);
                if (picked === undefined)
                    return;
                const index = Number(picked);
                const pending = pendingAttachments[index];
                if (pending === undefined)
                    return;
                const action = await showChoice(tui, palette, 'Attachment · ' + pending.label, [
                    { value: 'preview', label: 'Preview', description: pending.kind === 'image' ? 'Render the image' : 'Show up to 64 KiB of text' },
                    { value: 'remove', label: 'Remove', description: 'Unstage this attachment' },
                    { value: 'back', label: 'Back' },
                ], 'Enter selects · Esc closes', interactionAbort.signal);
                if (action === 'preview') {
                    await runCommand('/attach preview ' + String(index));
                    return;
                }
                if (action === 'remove') {
                    const removed = pendingAttachments.splice(index, 1)[0];
                    if (removed !== undefined)
                        pushNotice('info', 'Removed staged attachment: ' + removed.label);
                    renderStatus();
                }
                return;
            }
            case 'mcp': {
                const settings = host.get('settings') as unknown as SettingsService | undefined;
                if (settings === undefined) {
                    pushNotice('warning', 'The settings service is unavailable in this profile.');
                    return;
                }
                const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'mcp-manager');
                if (descriptor === undefined) {
                    pushNotice('warning', 'The MCP manager is unavailable; enable the dsh-mcp-client integration first.');
                    return;
                }
                const rawServers = descriptor.value.servers;
                const servers: Record<string, Record<string, unknown>> = rawServers !== null && typeof rawServers === 'object' && !Array.isArray(rawServers)
                    ? rawServers as Record<string, Record<string, unknown>>
                    : {};
                if (args === '' || args === 'list') {
                    const entries = Object.entries(servers);
                    if (entries.length === 0) {
                        pushNotice('info', 'No MCP servers configured. Use /mcp add.');
                        return;
                    }
                    const rows = entries.map(([name, raw]) => {
                        const transport = typeof raw.transport === 'string' ? raw.transport : 'unknown';
                        const target = transport === 'stdio'
                            ? [typeof raw.command === 'string' ? raw.command : '', ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].filter(Boolean).join(' ')
                            : typeof raw.url === 'string' ? raw.url : '';
                        return name + '  ' + transport + (target === '' ? '' : '  ' + target);
                    });
                    pushNotice('info', 'MCP servers:' + NL + rows.join(NL) + NL + 'Use /mcp add or /mcp remove <name>.');
                    return;
                }
                if (args === 'add') {
                    const name = await showTextInput(tui, palette, 'MCP server name', 'github', '[A-Za-z0-9_-]{1,32}; unique · Esc cancels', interactionAbort.signal);
                    if (name === undefined)
                        return;
                    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
                        pushNotice('warning', 'MCP server name must match [A-Za-z0-9_-]{1,32}.');
                        return;
                    }
                    if (Object.hasOwn(servers, name)) {
                        const confirmed = await showChoice(tui, palette, 'MCP server ' + name + ' already exists', [
                            { value: 'replace', label: 'Replace', description: 'Overwrite this server configuration' },
                            { value: 'cancel', label: 'Cancel' },
                        ], 'Enter selects · Esc cancels', interactionAbort.signal);
                        if (confirmed !== 'replace')
                            return;
                    }
                    const transport = await showChoice(tui, palette, 'MCP transport', [
                        { value: 'stdio', label: 'stdio', description: 'Spawn a local MCP server process' },
                        { value: 'streamable-http', label: 'Streamable HTTP', description: 'Connect to an HTTP MCP endpoint' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (transport === undefined)
                        return;
                    let config: Record<string, unknown>;
                    if (transport === 'stdio') {
                        const command = await showTextInput(tui, palette, 'MCP command', 'npx', 'Executable without shell interpolation · Esc cancels', interactionAbort.signal);
                        if (command === undefined)
                            return;
                        const argsRaw = await showTextInput(tui, palette, 'MCP arguments', '[]', 'Space-separated, or a JSON string array; optional · Esc cancels', interactionAbort.signal, '[]');
                        if (argsRaw === undefined)
                            return;
                        let argsValue: string[] = [];
                        if (argsRaw.trim() !== '') {
                            try {
                                const parsed = argsRaw.trim().startsWith('[') ? JSON.parse(argsRaw) : argsRaw.trim().split(/\s+/u);
                                if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string'))
                                    throw new Error('arguments must be strings');
                                argsValue = parsed;
                            }
                            catch (error) {
                                pushNotice('error', 'Invalid MCP arguments: ' + errorMessage(error));
                                return;
                            }
                        }
                        const envRaw = await showTextInput(tui, palette, 'MCP environment JSON', '{}', 'Optional JSON object; values merge over the scrubbed environment · Esc cancels', interactionAbort.signal, '{}');
                        if (envRaw === undefined)
                            return;
                        pushNotice('info', 'Applying MCP server ' + name + '…');
                        let envValue: Record<string, unknown> | undefined;
                        if (envRaw.trim() !== '' && envRaw.trim() !== '{}') {
                            try {
                                const parsed: unknown = JSON.parse(envRaw);
                                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                                    throw new Error('environment must be a JSON object');
                                envValue = parsed as Record<string, unknown>;
                            }
                            catch (error) {
                                pushNotice('error', 'Invalid MCP environment: ' + errorMessage(error));
                                return;
                            }
                        }
                        config = {
                            transport,
                            serverName: name,
                            command,
                            args: argsValue,
                            ...(envValue === undefined ? {} : { env: envValue }),
                        };
                    }
                    else {
                        const url = await showTextInput(tui, palette, 'MCP endpoint URL', 'http://localhost:3000/mcp', 'Streamable HTTP endpoint · Esc cancels', interactionAbort.signal);
                        if (url === undefined)
                            return;
                        const headersRaw = await showTextInput(tui, palette, 'MCP headers JSON', '{}', 'Optional JSON object of request headers · Esc cancels', interactionAbort.signal, '{}');
                        if (headersRaw === undefined)
                            return;
                        pushNotice('info', 'Applying MCP server ' + name + '…');
                        let headersValue: Record<string, unknown> | undefined;
                        if (headersRaw.trim() !== '' && headersRaw.trim() !== '{}') {
                            try {
                                const parsed: unknown = JSON.parse(headersRaw);
                                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                                    throw new Error('headers must be a JSON object');
                                headersValue = parsed as Record<string, unknown>;
                            }
                            catch (error) {
                                pushNotice('error', 'Invalid MCP headers: ' + errorMessage(error));
                                return;
                            }
                        }
                        config = {
                            transport,
                            serverName: name,
                            url,
                            ...(headersValue === undefined ? {} : { headers: headersValue }),
                        };
                    }
                    try {
                        await settings.update('mcp-manager', { servers: { [name]: config } }, descriptor.revision);
                        pushNotice('info', 'MCP server saved: ' + name + ' · ' + transport + '. Restart the session to load its tools if the connection was not live.');
                    }
                    catch (error) {
                        pushNotice('error', 'Could not save MCP server: ' + errorMessage(error));
                    }
                    return;
                }
                if (args.startsWith('remove ')) {
                    const name = args.slice('remove '.length).trim();
                    if (name === '' || !Object.hasOwn(servers, name)) {
                        pushNotice('warning', 'No configured MCP server "' + name + '".');
                        return;
                    }
                    const confirmed = await showChoice(tui, palette, 'Remove MCP server ' + name + '?', [
                        { value: 'yes', label: 'Remove', description: 'Remove this server from mcp-manager settings' },
                        { value: 'no', label: 'Cancel' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (confirmed !== 'yes')
                        return;
                    try {
                        await settings.mutate('mcp-manager', [{ op: 'unset', path: ['servers', name] }], descriptor.revision);
                        pushNotice('info', 'MCP server removed: ' + name);
                    }
                    catch (error) {
                        pushNotice('error', 'Could not remove MCP server: ' + errorMessage(error));
                    }
                    return;
                }
                pushNotice('warning', 'Usage: /mcp [add | list | remove <name>]');
                return;
            }
            case 'provider': {
                const settings = host.get('settings') as unknown as SettingsService | undefined;
                const llm = host.get('llm') as LlmCatalog | undefined;
                if (settings === undefined) {
                    pushNotice('warning', 'The settings service is unavailable in this profile.');
                    return;
                }
                if (llm === undefined) {
                    pushNotice('warning', 'The LLM catalog service is unavailable.');
                    return;
                }
                const credentials = host.get('credentials') as CredentialsService | undefined;
                const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai');
                if (descriptor === undefined) {
                    pushNotice('warning', 'The llm-pi-ai settings namespace is unavailable; mount the llm-pi-ai Host row first.');
                    return;
                }
                const currentProviders = descriptor.value.providers;
                const requireEnv = (env: string): boolean => {
                    if (!isValidEnvName(env)) {
                        pushNotice('warning', 'The credential field must be an UPPERCASE environment variable name, not the API key. Provider was not saved.');
                        return false;
                    }
                    const value = process.env[env];
                    if (value === undefined || value.trim() === '') {
                        pushNotice('warning', 'Environment variable ' + env + ' is not set in this dsh process. Export it before launching dsh, restart the TUI, then run /provider add again. Provider was not saved.');
                        return false;
                    }
                    return true;
                };
                const providerRecord: Record<string, unknown> = currentProviders !== null && typeof currentProviders === 'object' && !Array.isArray(currentProviders)
                    ? currentProviders as Record<string, unknown>
                    : {};
                const chooseProviderRoute = async (title: string): Promise<string | undefined> => {
                    const routes = Object.keys(providerRecord);
                    if (routes.length === 0) {
                        pushNotice('info', 'No third-party providers configured. Use /provider add.');
                        return undefined;
                    }
                    return showChoice(tui, palette, title, routes.map(route => ({
                        value: route,
                        label: route,
                        description: 'open provider configuration',
                    })), 'Enter opens · Esc cancels', interactionAbort.signal);
                };
                const fetchProviderModels = async (route: string): Promise<void> => {
                    const latest = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai');
                    const providers = latest?.value.providers;
                    const raw = providers !== null && typeof providers === 'object' && !Array.isArray(providers)
                        ? (providers as Record<string, unknown>)[route]
                        : undefined;
                    if (latest === undefined || raw === undefined) {
                        pushNotice('warning', 'No configured provider route "' + route + '".');
                        return;
                    }
                    const profile = raw !== null && typeof raw === 'object'
                        ? raw as { readonly baseURL?: unknown; readonly api?: unknown }
                        : {};
                    pushNotice('info', 'Fetching available models for ' + route + '…');
                    const discoveryAbort = new AbortController();
                    const timeout = setTimeout(() => discoveryAbort.abort(), 8000);
                    let discovered: readonly { readonly id: string; readonly name?: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly inputModalities?: readonly ('text' | 'image')[] }[] = [];
                    try {
                        discovered = await llm.discoverModels('llm-pi-ai', {
                            provider: route,
                            ...(typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {}),
                            ...(typeof profile.api === 'string' ? { api: profile.api } : {}),
                        }, AbortSignal.any([interactionAbort.signal, discoveryAbort.signal]));
                    }
                    catch (error) {
                        pushNotice('error', 'Could not fetch models for ' + route + ': ' + errorMessage(error));
                        return;
                    }
                    finally {
                        clearTimeout(timeout);
                    }
                    if (discovered.length === 0) {
                        pushNotice('warning', 'The provider returned no models for ' + route + '.');
                        return;
                    }
                    const merged = mergeDiscoveredProviderModels(raw, discovered);
                    try {
                        await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: merged.provider }], latest.revision);
                    }
                    catch (error) {
                        pushNotice('error', 'Fetched models but could not save them: ' + errorMessage(error));
                        return;
                    }
                    pushNotice('info', 'Fetched ' + String(discovered.length) + ' model(s) for ' + route + ': ' + String(merged.added) + ' added, ' + String(merged.updated) + ' refreshed. Use /model to switch.');
                };
                const editProvider = async (route: string): Promise<void> => {
                    if (!Object.hasOwn(providerRecord, route)) {
                        pushNotice('warning', 'No configured provider route "' + route + '".');
                        return;
                    }
                    const action = await showChoice(tui, palette, 'Provider ' + route, [
                        { value: 'fetch', label: 'Fetch available models', description: 'Discover models from the configured endpoint and merge them into this route' },
                        { value: 'cancel', label: 'Cancel' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (action === 'fetch')
                        await fetchProviderModels(route);
                };
                if (args === 'list') {
                    const entries = Object.entries(providerRecord);
                    if (entries.length === 0) {
                        pushNotice('info', 'No third-party providers configured. Use /provider add.');
                        return;
                    }
                    const rows = [];
                    for (const [route, raw] of entries) {
                        let count = 0;
                        try {
                            count = (await llm.listModels(route)).length;
                        }
                        catch {
                            // Missing credentials or invalid route: show the configured entry anyway.
                        }
                        const env = raw !== null && typeof raw === 'object' && typeof (raw as { readonly apiKeyEnv?: unknown }).apiKeyEnv === 'string'
                            ? (raw as { readonly apiKeyEnv: string }).apiKeyEnv
                            : undefined;
                        let envState = '';
                        if (env !== undefined) {
                            if (!isValidEnvName(env)) {
                                envState = '  (invalid env name; remove this route and rotate the key)';
                            }
                            else if (process.env[env] !== undefined) {
                                envState = '  ' + env;
                            }
                            else {
                                let stored = false;
                                if (credentials !== undefined) {
                                    try {
                                        stored = (await credentials.resolve(env))?.value !== undefined;
                                    }
                                    catch {
                                        // A credential-store read failure is shown as unset, not as a provider error.
                                    }
                                }
                                envState = '  ' + env + (stored ? ' (stored)' : ' (not set)');
                            }
                        }
                        rows.push(route + '  ' + String(count) + ' model(s)' + envState);
                    }
                    pushNotice('info', 'Configured third-party providers:' + NL + rows.join(NL)
                        + NL + 'Use /provider add to add one, /provider edit <route> to fetch models, /provider remove <route> to delete one.');
                    return;
                }
                if (args === '') {
                    const route = await chooseProviderRoute('Open provider');
                    if (route !== undefined)
                        await editProvider(route);
                    return;
                }
                if (args === 'edit' || args.startsWith('edit ')) {
                    const route = args === 'edit' ? await chooseProviderRoute('Open provider') : args.slice('edit '.length).trim();
                    if (route !== undefined)
                        await editProvider(route);
                    return;
                }
                if (args === 'models' || args.startsWith('models ')) {
                    const route = args === 'models' ? undefined : args.slice('models '.length).trim();
                    if (route === undefined || route === '') {
                        pushNotice('warning', 'Usage: /provider models <route>');
                        return;
                    }
                    if (!isValidProviderRoute(route)) {
                        pushNotice('warning', 'Invalid provider route "' + route + '".');
                        return;
                    }
                    await fetchProviderModels(route);
                    return;
                }
                if (args.startsWith('remove ')) {
                    const route = args.slice('remove '.length).trim();
                    if (route === '' || !isValidProviderRoute(route)) {
                        pushNotice('warning', 'Usage: /provider remove <route>');
                        return;
                    }
                    if (!Object.hasOwn(providerRecord, route)) {
                        pushNotice('warning', 'No configured provider route "' + route + '".');
                        return;
                    }
                    const confirmed = await showChoice(tui, palette, 'Remove provider ' + route + '?', [
                        { value: 'yes', label: 'Remove', description: 'Delete this route from llm-pi-ai settings' },
                        { value: 'no', label: 'Cancel' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (confirmed !== 'yes')
                        return;
                    try {
                        await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', route] }], descriptor.revision);
                        pushNotice('info', 'Removed provider route: ' + route);
                    }
                    catch (error) {
                        pushNotice('error', 'Could not remove provider: ' + errorMessage(error));
                    }
                    return;
                }
                if (args !== '' && args !== 'add') {
                    pushNotice('warning', 'Usage: /provider [add | list | edit [route] | models <route> | remove <route>]');
                    return;
                }
                try {
                    const kind = await showChoice(tui, palette, 'Provider type', [
                        { value: 'openai-completions', label: 'Custom OpenAI-compatible gateway', description: 'Chat Completions endpoint; you supply baseURL and model' },
                        { value: 'openai-responses', label: 'Custom OpenAI Responses gateway', description: 'Responses API endpoint; you supply baseURL and model' },
                        { value: 'anthropic-messages', label: 'Custom Anthropic-compatible gateway', description: 'Messages API endpoint; you supply baseURL and model' },
                        { value: 'catalog', label: 'Built-in pi-ai catalog route', description: 'Use a shipped provider catalog (for example openai, anthropic)' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (kind === undefined)
                        return;
                    const route = await showTextInput(tui, palette, 'Provider route', 'my-gateway', 'lowercase letters, digits, hyphens · Esc cancels', interactionAbort.signal);
                    if (route === undefined)
                        return;
                    if (!isValidProviderRoute(route)) {
                        pushNotice('warning', 'Provider route must start with a letter and contain only lowercase letters, digits, and hyphens.');
                        return;
                    }
                    const envDefault = route.toUpperCase().replace(/[^A-Z0-9]+/gu, '_') + '_API_KEY';
                    const baseURL = kind === 'catalog'
                        ? undefined
                        : await showTextInput(tui, palette, 'Base URL', 'https://api.example.com/v1', 'OpenAI-compatible API root · Esc cancels', interactionAbort.signal);
                    if (kind !== 'catalog' && baseURL === undefined)
                        return;
                    const credentialSource = await showChoice(tui, palette, 'Credential source', [
                        { value: 'store', label: 'Store API key in DSH credentials', description: 'Recommended; key goes to the credential store, not the profile' },
                        { value: 'env', label: 'Use an environment variable', description: 'Read a key exported before dsh started' },
                    ], 'Enter selects · Esc cancels', interactionAbort.signal);
                    if (credentialSource === undefined)
                        return;
                    let env: string;
                    let apiKey: string;
                    if (credentialSource === 'store') {
                        const credentials = host.get('credentials') as CredentialsService | undefined;
                        if (credentials === undefined) {
                            pushNotice('warning', 'The credential store is unavailable in this profile; choose the environment-variable option instead.');
                            return;
                        }
                        const secret = await showTextInput(tui, palette, 'API key (stored in DSH credentials)', 'paste the key here', 'Visible while typing; stored outside the profile config · Esc cancels', interactionAbort.signal);
                        if (secret === undefined)
                            return;
                        const value = secret.trim();
                        if (value === '') {
                            pushNotice('warning', 'API key must not be empty.');
                            return;
                        }
                        env = envDefault;
                        try {
                            await credentials.set(env, value);
                        }
                        catch (error) {
                            pushNotice('error', 'Could not store the API key: ' + errorMessage(error));
                            return;
                        }
                        apiKey = value;
                        pushNotice('info', 'Stored API key under credential reference ' + env + '.');
                    }
                    else {
                        const value = await showTextInput(tui, palette, 'API key env var NAME (not the key)', envDefault, 'UPPERCASE name like MY_GATEWAY_KEY; export the secret before launch · Esc cancels', interactionAbort.signal, envDefault);
                        if (value === undefined)
                            return;
                        if (!requireEnv(value))
                            return;
                        env = value;
                        apiKey = process.env[value]!;
                    }
                    let provider: Record<string, unknown>;
                    let chosenModel: string | undefined;
                    if (kind === 'catalog') {
                        provider = buildCatalogProvider(env);
                    }
                    else {
                        if (baseURL === undefined)
                            return;
                        const readManualModel = async (): Promise<{ id: string; name?: string; contextWindow: number; maxTokens: number } | undefined> => {
                            const modelId = await showTextInput(tui, palette, 'Model id', 'gpt-4o-mini', 'Exact model id sent on the wire · Esc cancels', interactionAbort.signal);
                            if (modelId === undefined)
                                return undefined;
                            const contextRaw = await showTextInput(tui, palette, 'Context window', '128000', 'Positive integer; Enter keeps the default · Esc cancels', interactionAbort.signal, '128000');
                            if (contextRaw === undefined)
                                return undefined;
                            const maxRaw = await showTextInput(tui, palette, 'Max output tokens', '16384', 'Positive integer; Enter keeps the default · Esc cancels', interactionAbort.signal, '16384');
                            if (maxRaw === undefined)
                                return undefined;
                            return { id: modelId, contextWindow: Number(contextRaw), maxTokens: Number(maxRaw) };
                        };
                        pushNotice('info', 'Discovering models from ' + baseURL + '…');
                        let discovered: readonly { readonly id: string; readonly name?: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly inputModalities?: readonly ('text' | 'image')[] }[] = [];
                        const discoveryAbort = new AbortController();
                        const timeout = setTimeout(() => discoveryAbort.abort(), 5000);
                        try {
                            discovered = await llm.discoverModels('llm-pi-ai', {
                                baseURL,
                                api: kind,
                                apiKey,
                            }, AbortSignal.any([interactionAbort.signal, discoveryAbort.signal]));
                        }
                        catch (error) {
                            pushNotice('warning', 'Automatic model discovery failed: ' + errorMessage(error) + ' — falling back to manual model id.');
                        }
                        finally {
                            clearTimeout(timeout);
                        }
                        let model: { id: string; name?: string; contextWindow: number; maxTokens: number; inputModalities?: readonly ('text' | 'image')[] } | undefined;
                        if (discovered.length > 0) {
                            const choice = await showChoice(tui, palette, 'Select model from ' + route, [
                                ...discovered.map((candidate, index) => ({
                                    value: String(index),
                                    label: candidate.id,
                                    description: candidate.name ?? 'discovered by the endpoint',
                                })),
                                { value: '__manual__', label: 'Enter model id manually', description: 'Use a model the endpoint did not list' },
                            ], 'Enter selects · Esc cancels', interactionAbort.signal);
                            if (choice === undefined)
                                return;
                            if (choice === '__manual__') {
                                model = await readManualModel();
                            }
                            else {
                                const found = discovered[Number(choice)];
                                if (found !== undefined) {
                                    model = {
                                        id: found.id,
                                        ...(found.name === undefined ? {} : { name: found.name }),
                                        contextWindow: typeof found.contextWindow === 'number' && found.contextWindow > 0 ? found.contextWindow : 128000,
                                        maxTokens: typeof found.maxTokens === 'number' && found.maxTokens > 0 ? found.maxTokens : 16384,
                                        ...(found.inputModalities === undefined ? {} : { inputModalities: found.inputModalities }),
                                    };
                                }
                            }
                        }
                        else {
                            pushNotice('info', 'No models discovered from the endpoint; entering model id manually.');
                            model = await readManualModel();
                        }
                        if (model === undefined)
                            return;
                        const supportsImage = model.inputModalities?.includes('image') === true;
                        const imageFirst = supportsImage || model.inputModalities === undefined;
                        const inputChoice = await showChoice(tui, palette, 'Input modalities', imageFirst
                            ? [
                                { value: 'image', label: 'Text + image', description: supportsImage ? 'The endpoint reports image input' : 'Only if the endpoint accepts image input' },
                                { value: 'text', label: 'Text only', description: 'Safest for text-only models' },
                            ]
                            : [
                                { value: 'text', label: 'Text only', description: 'The endpoint reports text input only' },
                                { value: 'image', label: 'Text + image', description: 'Override only if the endpoint accepts images' },
                            ], 'Enter selects · Esc cancels', interactionAbort.signal);
                        if (inputChoice === undefined)
                            return;
                        const input = inputChoice === 'image' ? ['text', 'image'] as const : ['text'] as const;
                        const reasoningRaw = await showTextInput(tui, palette, 'Reasoning levels', 'low, medium, high', 'Comma-separated: off/minimal/low/medium/high/xhigh/max; blank = no reasoning · Esc cancels', interactionAbort.signal, 'low,medium,high');
                        if (reasoningRaw === undefined)
                            return;
                        let reasoningEfforts: Record<string, string | null> | undefined;
                        try {
                            reasoningEfforts = parseReasoningLevels(reasoningRaw);
                        }
                        catch (error) {
                            pushNotice('warning', 'Invalid reasoning levels: ' + errorMessage(error));
                            return;
                        }
                        chosenModel = model.id;
                        provider = buildCustomProvider({
                            route,
                            api: kind as ProviderProtocol,
                            baseURL,
                            apiKeyEnv: env,
                            modelId: model.id,
                            ...(model.name === undefined ? {} : { modelName: model.name }),
                            contextWindow: model.contextWindow,
                            maxTokens: model.maxTokens,
                            input,
                            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
                        });
                        const selectedModels = (provider as { models?: Record<string, unknown>[] }).models;
                        if (Array.isArray(selectedModels)) {
                            for (const candidate of discovered) {
                                if (candidate.id === model.id)
                                    continue;
                                selectedModels.push({
                                    id: candidate.id,
                                    name: candidate.name ?? candidate.id,
                                    contextWindow: typeof candidate.contextWindow === 'number' && candidate.contextWindow > 0 ? candidate.contextWindow : 128000,
                                    maxTokens: typeof candidate.maxTokens === 'number' && candidate.maxTokens > 0 ? candidate.maxTokens : 16384,
                                    ...(candidate.inputModalities === undefined || candidate.inputModalities.length === 0
                                        ? {}
                                        : { input: [...candidate.inputModalities] }),
                                });
                            }
                        }
                    }
                    if (Object.hasOwn(providerRecord, route)) {
                        const existing = providerRecord[route];
                        if (kind === 'catalog') {
                            const confirmed = await showChoice(tui, palette, 'Provider route ' + route + ' already exists', [
                                { value: 'yes', label: 'Replace credential', description: 'Replace this catalog route profile' },
                                { value: 'no', label: 'Cancel' },
                            ], 'Enter selects · Esc cancels', interactionAbort.signal);
                            if (confirmed !== 'yes')
                                return;
                        }
                        else {
                            const confirmed = await showChoice(tui, palette, 'Provider route ' + route + ' already exists', [
                                { value: 'merge', label: 'Add/replace this model, keep other models', description: 'Append to the existing route and keep its other models' },
                                { value: 'replace', label: 'Replace entire route', description: 'Discard the existing model list' },
                                { value: 'cancel', label: 'Cancel' },
                            ], 'Enter selects · Esc cancels', interactionAbort.signal);
                            if (confirmed === undefined || confirmed === 'cancel')
                                return;
                            if (confirmed === 'merge')
                                provider = mergeProviderModel(existing, provider);
                        }
                    }
                    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: provider }], descriptor.revision);
                    pushNotice('info', 'Saved provider route: ' + route + ' · key is read from ' + (provider as { apiKeyEnv?: string }).apiKeyEnv);
                    if (chosenModel !== undefined) {
                        await selectModel(llm, route + '/' + chosenModel);
                        return;
                    }
                    let models: readonly { readonly id: string; readonly name: string; readonly description?: string }[] = [];
                    try {
                        models = await llm.listModels(route);
                    }
                    catch (error) {
                        pushNotice('warning', 'Provider saved, but its model list is currently unavailable: ' + errorMessage(error));
                        return;
                    }
                    if (models.length === 0) {
                        pushNotice('warning', 'Provider saved, but /model sees no models yet. Export '
                            + String((provider as { apiKeyEnv?: string }).apiKeyEnv ?? 'the API key env var')
                            + ' before launching dsh, then restart the TUI or run /model.');
                        return;
                    }
                    const selected = await showChoice(tui, palette, 'Model for ' + route, models.map(model => ({
                        value: route + '/' + model.id,
                        label: model.id,
                        description: model.name,
                    })), 'Enter selects · Esc keeps the current model', interactionAbort.signal);
                    if (selected !== undefined)
                        await selectModel(llm, selected);
                    return;
                }
                catch (error) {
                    pushNotice('error', 'Provider setup failed: ' + errorMessage(error));
                    return;
                }
            }
            default: {
                try {
                    const execution = await host.commands.execute(active.agent, line, [], new AbortController().signal);
                    if (execution === undefined) {
                        pushNotice('warning', 'Unknown command: /' + name + '. Use /help for local and host commands.');
                    }
                    else if (execution.result.text !== undefined && execution.result.text !== '') {
                        pushNotice(execution.result.kind === 'error' ? 'error' : 'info', execution.result.text);
                    }
                }
                catch (error) {
                    pushNotice('error', 'Command failed: ' + errorMessage(error));
                }
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
        await active.dispose();
    };
    editor.onSubmit = handleSubmit;
    tui.addInputListener((data) => {
        if (data === '\u001B') {
            if (tui.hasOverlay())
                return undefined;
            if (active.agent.status === 'running') {
                active.agent.cancel({ kind: 'user' });
                return { consume: true };
            }
            return undefined;
        }
        if (data === String.fromCharCode(3)) {
            if (active.agent.status === 'running') {
                active.agent.cancel({ kind: 'user' });
                return { consume: true };
            }
            requestExit(0);
            return { consume: true };
        }
        if (data === String.fromCharCode(4)) {
            requestExit(0);
            return { consume: true };
        }
        return undefined;
    });
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    try {
        registerInteractions();
        subscribeActive();
        tui.start();
        tui.setFocus(editor);
        tui.requestRender();
    }
    catch (error) {
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
        await dispose();
        throw error;
    }
    return {
        dispose: async () => {
            await dispose();
        },
    };
}
//# sourceMappingURL=app.js.map