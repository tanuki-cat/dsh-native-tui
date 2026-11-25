import { TuiAltScreen } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { bindModelSelection } from '../runtime/model-selection.js'
import type {} from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DisplayMode, ResolvedConfig } from '../config.js'
import { createHostSession, readContextBreakdown, restartHostSession, resumeHostSession, sessionAgentPreset, type AgentPresetService, type HostSession } from '../runtime/agent.js'
import { assertResumed, reloadArgs } from '../runtime/reload.js'
import { createSessionMetricsMemo, type SessionMetrics } from '../runtime/metrics.js'
import { ContextModelBudgets, readContextInputs, SessionEventCursor } from '../runtime/context-reading.js'
import { sameRoute } from '../runtime/compaction-policy.js'
import { createGitBranchReader } from '../runtime/git-branch.js'
import { currentWorkingDirectory } from '../runtime/working-directory.js'
import { showApproval, showQuestionBatch } from './dialogs.js'
import { approvalArguments, approvalReceipt } from './approval-preview.js'
import type { PendingAttachment } from '../runtime/attachments.js'
import { TuiAutocompleteProvider, type SessionReferenceService, type SkillSuggestion } from './autocomplete.js'
import { currentPreset, renderStatusRows, terminalWindowTitle } from './status-line.js'
import { createStatusRows } from './status-rows.js'
import { debug } from '../debug.js'
import { globalShortcut } from './keymap.js'
import { CommandDispatchTracker } from './command-dispatch.js'
import { SkillCatalogCache } from './skill-cache.js'
import { LOCAL_COMMANDS } from './commands/catalog.js'
import type { CommandContext } from './commands/context.js'
import { runCommandLine } from './commands/router.js'
import { cycleReasoningEffort } from './commands/model.js'
import type { InteractionModeService as ModeService } from '../interaction-modes.js'
import type { AgentDefaultModelService, LLM, PermissionPresets, SkillsCatalog } from './commands/services.js'
import { openTuiSettings, showHostSettings } from './commands/settings.js'
import { errorMessage } from './commands/shared.js'
import { subscribeSessionEvents } from './session-events.js'
import { streamingRowKey, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import type { WaitRetry } from './waiting.js'
import { holdProcessWarnings, type WarningGuard } from './warnings.js'
import { consoleTone, holdConsoleOutput, type ConsoleGuard } from './console-guard.js'
import { wireImageInput } from './image-input.js'
import type { ContextReportData } from './context-report.js'
import { SessionDrafts } from './session-drafts.js'
import { enqueuePrompt, submitDraft } from './prompt-submission.js'
import { pickStoredSession } from './commands/sessions.js'
import { AppShutdown, createSignalExit, createTerminalSurface, replaceProcess, reportExitSession, TranscriptFrames } from './app-lifecycle.js'
import { handOverSession, resetInteractionScope, runGlobalShortcut, shortcutDisposition, type GlobalShortcutActions } from './app-session.js'

/** Terminal application lifecycle. */
export interface TerminalApp {
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void
  setMaxEntries(maxEntries: number): void
  setImageThumbnails(enabled: boolean): void
  /** Replace the product title shown in the header and status row. */
  setTitle(title: string): void
  /** Session currently on screen; an in-process plugin replacement reopens it. */
  activeSessionId(): string
  dispose(): Promise<void>
}

const MAX_NOTICES = 12

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
  const { terminal, terminalTheme, palette, tui, header, editor, waitStatus, status, footer, renderer } =
    createTerminalSurface(config)
  let reasoningEffort: string | undefined

  let active: HostSession
  try {
    active = config.sessionId === undefined
      ? await createHostSession(host, config)
      : await resumeHostSession(host, config.sessionId as SessionId)
  } catch (error) {
    throw new Error('native-tui: failed to open a session: ' + errorMessage(error), { cause: error })
  }
  // A resume that lands elsewhere would silently look like a fresh session.
  try {
    assertResumed(config.sessionId, active.id)
  } catch (error) {
    await active.dispose()
    throw error
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
  const skills = new SkillCatalogCache(skillRegistry,
    agent => currentWorkingDirectory(host, agent.session, config.cwd), agent => active.agent === agent)
  const loadSkills = (): Promise<readonly SkillSuggestion[]> => skills.load(active.agent)
  const autocomplete = new TuiAutocompleteProvider({
    getAgent: () => active.agent,
    getCommands: () => [...LOCAL_COMMANDS, ...host.commands.list(active.agent)],
    getSkills: loadSkills,
    getFileReferences: () => host.get('fileReferences') as import('@deepseek-ai/dsh-file-reference').FileReferenceService | undefined,
    getSessionReferences: () => host.get('sessionReferenceResolver') as SessionReferenceService | undefined,
  })
  editor.setAutocompleteProvider(autocomplete)

  /** Holds Node warnings while the UI owns the screen; released once it is restored. */
  let warningGuard: WarningGuard | undefined
  /** Holds Host/dependency console output for the same span. */
  let consoleGuard: ConsoleGuard | undefined
  let reportedSession = false
  let switching = false
  /** Set when a restart closed the old Agent and could not restore it. */
  let sessionLost = false
  let title = config.title
  /** Last title written to the terminal, so a repaint does not repeat the sequence. */
  let windowTitle: string | undefined
  let selectedPreset: string | undefined = sessionAgentPreset(active.agent.session)
    ?? config.agentPreset
    ?? (host.get('agentPresets') as AgentPresetService | undefined)?.defaultId
  let liveSeq = 0
  let entries: TranscriptEntry[] = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
  let localNotices: TranscriptBlock[] = []
  let pendingAttachments: PendingAttachment[] = []
  const drafts = new SessionDrafts()
  let unsubscribeSession: (() => void) | undefined
  let interactionDisposers: Array<() => void> = []
  /** Cancellation of the whole terminal, so a dispatch and its dialogs end with it. */
  const interactionAbort = new AbortController()
  /** Cancellation of the approval/question dialogs bound to the Session on screen. */
  let sessionScope = new AbortController()
  /** The `/` dispatch in flight, so Escape can cancel the command being waited on. */
  const commandDispatch = new CommandDispatchTracker(interactionAbort.signal)
  const attemptPositions = new Map<string, { turn: number; step: number }>()
  let contextBudgets = new ContextModelBudgets()
  let modelSelection = bindModelSelection(active.agent)
  reasoningEffort = modelSelection.current?.reasoningEffort

  const summaryCwd = (): string | undefined => {
    try { return currentWorkingDirectory(host, active.agent.session, config.cwd) }
    catch { return undefined }
  }

  /** Branch of the workspace the row names; cached so a repaint does not re-read Git. */
  const workspaceBranch = createGitBranchReader(undefined, undefined, () => { renderStatus() })

  /**
   * Name the workspace in the terminal tab.
   *
   * Written only when the label changes: OSC 0 is a terminal-wide side effect,
   * and the status block repaints on every Session event.
   */
  const syncWindowTitle = (): void => {
    const next = terminalWindowTitle(title, summaryCwd() ?? '')
    if (next === windowTitle) return
    windowTitle = next
    terminal.setTitle(next)
  }

  const lastDurableSeq = (): number | undefined => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.type === 'event') return Number(entry.event.seq)
    }
    return undefined
  }

  /** Rebuild the transcript and paint it, dropping entries no retained row needs. */
  const renderTranscript = (): void => {
    // Bound the next rebuild before pacing it.
    const retained = frames.render(entries, localNotices, summaryCwd())
    if (retained > 0) entries = entries.slice(retained)
  }

  /** Paces transcript frames and owns the wait row's elapsed-time ticker. */
  const frames = new TranscriptFrames({
    tui,
    renderer,
    waitStatus,
    columns: () => terminal.columns,
    disposed: () => shutdown.disposed,
  }, renderTranscript)

  /** Build the initial transcript before the first frame paints it. */
  const warmTranscript = (): void => { frames.warm(entries, localNotices, summaryCwd()) }

  /** Ask for a transcript frame; bursts are coalesced into one per interval. */
  const scheduleTranscript = (immediate = false): void => { frames.schedule(immediate) }

  /** Clear live status, the last receipt and every scheduled frame. */
  const clearWait = (): void => { frames.clear() }

  /** Execution status follows Host events, never receipt or playback of text. */
  const beginWait = (retry?: WaitRetry): void => { frames.beginWait(retry) }

  const pushNotice = (tone: 'info' | 'warning' | 'error' | 'success', text: string, contextReport?: ContextReportData): void => {
    const streamKey = streamingRowKey(entries)
    localNotices.push({
      kind: 'notice',
      tone,
      text,
      ...(contextReport === undefined ? {} : { contextReport }),
      afterSeq: lastDurableSeq() ?? 0,
      ...(streamKey === undefined ? {} : { afterStreamKey: streamKey }),
    })
    if (localNotices.length > MAX_NOTICES) localNotices = localNotices.slice(-MAX_NOTICES)
    scheduleTranscript(true)
  }

  /** One fold per application, so a repaint over an unchanged log is free. */
  const metricsFold = createSessionMetricsMemo()
  const sessionCursor = new SessionEventCursor()

  const contextInputs = () => readContextInputs(host, active.agent, modelSelection.current, contextBudgets, sessionCursor)

  /**
   * The context figures both readers share: the status row prices them on every
   * event, and `/context` prints the same numbers on demand through the one
   * memoized fold, so a repaint between the two cannot make them disagree.
   * @returns the folded metrics and the meter's heuristic composition.
   */
  const readContextFigures = (): { readonly metrics: SessionMetrics; readonly breakdown: ReturnType<typeof readContextBreakdown> } => {
    const inputs = contextInputs()
    const metrics = metricsFold(inputs.events, inputs.stats, inputs.window, inputs.meter.reading, inputs.compaction)
    return {
      metrics,
      // Rebased onto the occupancy the row reports, so the split can never add
      // up to more context than the session is actually paying for.
      breakdown: readContextBreakdown(inputs.projections, active.agent.session, metrics.contextEstimateTokens, inputs.values),
    }
  }

  /**
   * Coalesce status repaints.
   *
   * One durable event per model step arrives in bursts — a settlement, its tool
   * call, the step end — and each used to repaint the row and request a full
   * screen render. Painting once per burst keeps the event loop free for the
   * stream reads that the decode timing is measured from.
   */
  let statusScheduled = false

  const renderStatus = (): void => {
    if (shutdown.disposed || statusScheduled) return
    statusScheduled = true
    setImmediate(() => {
      statusScheduled = false
      paintStatus()
    })
  }

  // The chrome rows are deduplicated: an identical repaint only costs the fold.
  const statusRows = createStatusRows({ header, status, footer })

  const paintStatus = (): void => {
    if (shutdown.disposed) return
    reasoningEffort = modelSelection.current?.reasoningEffort
    const options = active.agent.options
    const inputs = contextInputs()
    const cwd = summaryCwd()
    statusRows.reset()
    renderStatusRows(statusRows.rows, palette, {
      title,
      sessionId: active.id,
      cwd: cwd ?? 'Workspace unavailable',
      gitBranch: cwd === undefined ? undefined : workspaceBranch(cwd),
      running: active.agent.status === 'running',
      provider: modelSelection.current?.provider ?? options.provider ?? 'deepseek-official',
      model: modelSelection.current?.model ?? options.model ?? 'deepseek-flash',
      reasoningEffort,
      interactionMode: (host.get('interactionModes') as ModeService | undefined)?.current(active.agent),
      permissionPreset: (host.get('permissionPresets') as PermissionPresets | undefined)?.current(active.agent.session),
      preset: currentPreset(host.get('agentPresets') as AgentPresetService | undefined, active.agent.ctx),
      attachmentCount: pendingAttachments.length,
      contextWindow: inputs.window,
      contextMeter: inputs.meter.reading,
      compaction: inputs.compaction,
      compactionBaselinePercent: inputs.compactionBaselinePercent,
      stats: inputs.stats,
      events: inputs.events,
    }, metricsFold)
    if (!statusRows.changed) return
    syncWindowTitle()
    tui.requestRender()
  }

  const refreshContextWindow = async (force = false): Promise<void> => {
    const budgets = contextBudgets
    const llm = host.get('llm') as LLM | undefined
    if (llm === undefined) return
    const selected = modelSelection.current
    const routed = active.agent.session.requestHeader()?.config
    await Promise.all([budgets.refresh(llm, selected, force),
      sameRoute(selected, routed) ? undefined : budgets.refresh(llm, routed, force)])
    if (budgets === contextBudgets) renderStatus()
  }

  const subscribeActive = (): void => {
    const stopEvents = subscribeSessionEvents({
      host,
      sessionId: () => active.id,
      appendEntry: entry => {
        if (entry.type === 'event' && entry.event.type === 'request/context') void refreshContextWindow()
        const chunk = entry.type === 'live' ? entry.event.data.chunk : undefined
        if (chunk !== undefined) frames.resumeWait()
        if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
          debug(`stream chunk: ${chunk.type} ${String(chunk.text.length)} chars`)
        }
        else if (chunk?.type === 'block-start') {
          debug(`stream chunk: block-start ${chunk.blockType} #${String(chunk.index)}`)
        }
        else if (chunk?.type === 'tool-call-delta') {
          debug(`stream chunk: tool-call-delta ${String(chunk.argumentsDelta.length)} chars`)
        }
        else if (chunk?.type === 'block-end') {
          const block = chunk.block
          const size = block.type === 'text' || block.type === 'reasoning' ? block.text.length : 0
          debug(`stream chunk: block-end ${block.type} ${String(size)} chars`)
        }
        entries.push(entry)
      },
      replaceEntries: update => { entries = update(entries) },
      notice: text => pushNotice('info', text),
      scheduleTranscript: () => scheduleTranscript(),
      renderStatus,
      beginAttempt: (id, turn, step) => { attemptPositions.set(id, { turn, step }) },
      endAttempt: id => { attemptPositions.delete(id) },
      nextLiveSeq: () => { liveSeq += 1; return liveSeq },
      attemptPosition: id => attemptPositions.get(id),
      beginWait,
      retryScheduled: retry => beginWait(retry),
      endWait: reason => { frames.finishWait(reason) },
    })
    // The Host's app-boot package declares this event and is outside this plugin's type dependencies.
    const stopReload = (host as unknown as { on(name: 'app-boot/config-reload', callback: () => void): () => void })
      .on('app-boot/config-reload', () => { void refreshContextWindow(true) })
    unsubscribeSession = () => { stopEvents(); stopReload() }
    scheduleTranscript(true)
    renderStatus()
  }

  const clearSubscriptions = (): void => {
    unsubscribeSession?.()
    unsubscribeSession = undefined
    clearWait()
  }

  /** Cancellation binding one Host interaction to the terminal and the Session on screen. */
  const interactionSignal = (requestSignal: AbortSignal | undefined): AbortSignal => requestSignal === undefined
    ? AbortSignal.any([interactionAbort.signal, sessionScope.signal])
    : AbortSignal.any([requestSignal, interactionAbort.signal, sessionScope.signal])

  const registerInteractions = (): void => {
    const agent = active.agent
    interactionDisposers = [
      agent.ctx.on('approval/request', async (request, next) => {
        if (request.agent !== agent) return next()
        const args = approvalArguments(agent.session.snapshotEvents(), request.toolName, request.callId)
        const outcome = await showApproval(tui, palette, request, interactionSignal(request.signal), { cwd: summaryCwd() })
        if (!shutdown.disposed && active.agent === agent) {
          const receipt = approvalReceipt(request.toolName, args, outcome)
          pushNotice(receipt.tone, receipt.text)
        }
        return outcome
      }),
      agent.ctx.on('user-questions/request', async (request, next) => {
        if (request.agent !== agent) return next()
        return showQuestionBatch(tui, palette, request.questions, interactionSignal(request.signal))
      }),
    ]
  }

  const disposeInteractions = (): void => {
    for (const dispose of interactionDisposers) dispose()
    interactionDisposers = []
  }

  let reasoningCycle = Promise.resolve()

  /**
   * Move the terminal to another Session.
   *
   * A normal switch re-attaches the outgoing Session when it cannot be
   * released, so a failed disposal leaves a working screen. A restart is the
   * exception: its opener releases the old Agent itself, so a failure has no
   * handle to return to and the Session stays lost until a reload.
   * @param next - opens the replacement.
   * @param options - `disposesActive` when `next` releases the outgoing Agent.
   */
  const switchTo = async (
    next: () => Promise<HostSession>,
    options?: { readonly disposesActive?: boolean; readonly previousClosed?: () => boolean },
  ): Promise<void> => {
    await editor.whenInputIdle()
    if (switching || shutdown.disposed) return
    switching = true
    editor.disableSubmit = true
    try {
      const result = await handOverSession<HostSession>({
        current: active,
        open: next,
        release: session => session.dispose(),
        closedByOpener: options?.disposesActive === true,
        ...(options?.previousClosed === undefined ? {} : { previousClosed: options.previousClosed }),
        aborted: () => shutdown.disposed,
        detach: () => {
          // The Session leaving the screen owns its draft, subscriptions and
          // dialogs; stop them before its Agent is released.
          drafts.save(active.agent.session, { text: editor.getExpandedText(), attachments: pendingAttachments }, summaryCwd(), selectedPreset)
          disposeInteractions()
          clearSubscriptions()
          sessionScope = resetInteractionScope(sessionScope, tui)
        },
        attach: () => {
          // The old Session still owns the screen: restore what a failed
          // handover detached instead of leaving the terminal disconnected.
          registerInteractions()
          subscribeActive()
        },
        adopt: opened => {
          active = opened
          sessionLost = false
          reasoningCycle = Promise.resolve()
          const draft = drafts.restore(active.id)
          editor.setText(draft.text)
          pendingAttachments = draft.attachments
          selectedPreset = sessionAgentPreset(active.agent.session) ?? selectedPreset
          entries = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
          liveSeq = 0
          attemptPositions.clear()
          skills.clear()
          localNotices = []
          renderer.clear()
          frames.reset()
          tui.setFocus(editor)
          modelSelection = bindModelSelection(active.agent)
          contextBudgets = new ContextModelBudgets()
          registerInteractions()
          subscribeActive()
          void refreshContextWindow()
          pushNotice('info', 'Switched to ' + active.id)
        },
      })
      if (result.status === 'failed') {
        if (result.restorable) {
          pushNotice('error', 'Could not open the session: ' + errorMessage(result.error))
        }
        else {
          // The old Agent is already gone; block prompts until a reload opens
          // a fresh handle instead of writing to a disposed one.
          sessionLost = true
          pushNotice('error', 'Could not restore the session: ' + errorMessage(result.error) + ' · run /reload to reopen it')
        }
      }
      if (result.status !== 'switched' && result.status !== 'same' && result.unopened !== undefined) {
        try { await result.unopened.dispose() }
        catch (error) { pushNotice('error', 'Could not close the unopened session: ' + errorMessage(error)) }
      }
    }
    finally {
      switching = false
      // Prompts stay blocked by `sessionLost` in handleSubmit; Enter must still
      // reach `/reload`, the one command that can reopen a lost Session.
      editor.disableSubmit = false
    }
  }

  const openNewSession = async (cwd: string, preset?: string): Promise<HostSession> => {
    const presets = host.get('agentPresets') as AgentPresetService | undefined
    const targetPreset = presets === undefined ? preset : (await presets.resolve(preset)).id
    drafts.save(active.agent.session, { text: editor.getExpandedText(), attachments: pendingAttachments }, summaryCwd(), selectedPreset)
    const registry = host.get('workspaceRegistry') as { readonly archivedSessionIds: readonly string[] } | undefined
    const id = drafts.findBlank(cwd, targetPreset, registry?.archivedSessionIds)
    if (id === active.id) return active
    return id === undefined
      ? createHostSession(host, { ...config, cwd, agentPreset: targetPreset, sessionId: undefined })
      : resumeHostSession(host, id)
  }

  /**
   * Put a skill invocation in front of whatever the user has already typed.
   *
   * The namespaced form bypasses commands with the same name. Prepending keeps
   * the invocation separate from the existing draft and leaves room for instructions.
   * @param name - kebab-case skill name the Host marked user-invocable.
   */
  const stageSkillInvocation = (name: string): void => {
    const existing = editor.getExpandedText()
    const token = '/skill:' + name + ' '
    editor.setText(existing.trim() === '' ? token : token + existing)
    tui.setFocus(editor)
    tui.requestRender()
  }

  const sendPrompt = (text: string, historyText = text): boolean => {
    if (sessionLost) {
      pushNotice('error', 'The Session is no longer open · run /reload to reopen it')
      return false
    }
    try {
      if (!enqueuePrompt(active.agent, text, pendingAttachments)) return false
    } catch (error) {
      if (historyText.startsWith('/') && editor.getText() === '') editor.setText(historyText)
      pushNotice('error', 'Prompt failed: ' + errorMessage(error))
      return false
    }
    editor.addToHistory(historyText)
    renderStatus()
    return true
  }

  /**
   * The handler-facing view of this application. It is built per command run so
   * a handler always sees the session that is on screen now, not the one that
   * was active when this closure was created.
   * @param dispatchSignal - cancellation of the dispatch that asked for it.
   */
  const commandContext = (dispatchSignal?: AbortSignal): CommandContext => {
    const attachments = pendingAttachments
    const session = active, owner = modelSelection
    const isCurrent = (): boolean => active === session && modelSelection === owner
      && !switching && !sessionLost && !shutdown.disposed && !shutdown.exiting
    return {
      host,
      config,
      palette,
      tui,
      active,
      restartSession: async expected => {
        if (expected !== active || switching || shutdown.disposed) throw new Error('The active Session changed; choose permissions again.')
        // Refuse before detaching the UI: a running turn is not a failed restart.
        if (expected.agent.status === 'running') throw new Error('Wait for the running turn to finish or cancel it before resetting shells.')
        let reopened: HostSession | undefined
        let disposedPrevious = false
        await switchTo(async () => {
          reopened = await restartHostSession(host, expected, () => { disposedPrevious = true })
          return reopened
        }, { disposesActive: true, previousClosed: () => disposedPrevious })
        if (reopened === undefined || active !== reopened) {
          throw new Error(disposedPrevious
            ? 'Could not restore the Session after closing persistent shells; use /reload to retry.'
            : 'Could not close persistent shells for the active Session.')
        }
        return active
      },
      signal: dispatchSignal ?? commandDispatch.signal(),
      isCurrent,
      notice: pushNotice,
      renderStatus,
      attachments: {
        pending: attachments,
        clear: () => { attachments.splice(0) },
      },
      runCommand: line => runCommand(line),
      openTuiSettings: () => openTuiSettings(commandContext()),
      showHostSettings: () => showHostSettings(commandContext()),
      modelSelection,
      setContextWindow: (route, tokens, reservedTokens) => { contextBudgets.remember(route, tokens, reservedTokens) },
      readContext: readContextFigures,
      stageSkillInvocation,
      persistSelection: async selection => {
        if (!isCurrent()) return
        const service = host.get('agentDefaultModel') as AgentDefaultModelService | undefined
        if (service === undefined) return
        try {
          await service.saveSelection({
            provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
          })
        } catch (error) {
          if (isCurrent()) pushNotice('warning', 'Selection applies now but could not be saved: ' + errorMessage(error))
        }
      },
    }
  }

  /**
   * Route one `/` line through the command dispatcher. Only what a handler
   * cannot reach through its command context is injected here: the session
   * switch, prompts, the transcript reset, and the preset record.
   */
  const runCommand = (line: string): Promise<void> => {
    const dispatch = commandDispatch.begin()
    return runCommandLine(line, {
      context: commandContext,
      signal: dispatch.signal,
      cancelled: dispatch.cancelled,
      switchTo,
      openNewSession,
      sendPrompt,
      clearTranscript: () => {
        entries = []
        localNotices = []
        renderer.clear()
        frames.reset()
        scheduleTranscript(true)
      },
      exit: requestExit,
      reload: requestReload,
      preset: {
        current: () => selectedPreset,
        select: id => { selectedPreset = id },
      },
      skills: loadSkills,
    }).finally(dispatch.release)
  }

  const handleSubmit = (text: string): void => {
    if (shutdown.exiting) return
    const trimmed = text.trim()
    if (trimmed === '' && pendingAttachments.length === 0) return
    if (trimmed === 'exit' || trimmed === 'quit') {
      requestExit(0)
      return
    }
    if (sessionLost && trimmed !== '/reload') {
      // The Agent behind this draft is gone; only a reload can reopen a Session.
      pushNotice('error', 'The Session is no longer open \u00b7 run /reload to reopen it')
      return
    }
    if (trimmed.startsWith('/')) {
      editor.setText('')
      void runCommand(trimmed)
      return
    }
    submitDraft(text, editor, () => sendPrompt(trimmed))
  }

  /** Tear the terminal down once; every exit path awaits this same run. */
  const performDispose = async (reportSession: boolean): Promise<void> => {
    terminalTheme.dispose()
    editor.cancelPendingInput()
    interactionAbort.abort(new Error('native-tui: terminal disposed'))
    sessionScope.abort(new Error('native-tui: terminal disposed'))
    disposeInteractions()
    clearSubscriptions()
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    try {
      tui.stop()
    }
    catch {
      // The terminal may already be gone; restoration is best-effort here.
    }
    // Both guards kept output off the screen while it was live; restore them
    // before anything else writes to the terminal again.
    consoleGuard?.restore()
    consoleGuard = undefined
    // Warnings were kept off the screen while it was live; with the terminal
    // restored they can be reported where a raw stderr write is harmless.
    for (const warning of warningGuard?.restore() ?? []) {
      try {
        process.stderr.write('(node warning) ' + warning + '\n')
      }
      catch {
        // A closed stderr must not turn a normal exit into a failure.
      }
    }
    warningGuard = undefined
    if (reportSession && !reportedSession) {
      reportedSession = true
      await reportExitSession(active.id)
    }
    await active.dispose()
  }

  /** One teardown and one process exit, shared by every exit path. */
  const shutdown = new AppShutdown(performDispose)

  const dispose = (reportSession = true): Promise<void> => shutdown.dispose(reportSession)

  const requestExit = (code: number): void => {
    if (!shutdown.claimExit()) return
    void dispose().then(() => { onExit(code) }, () => { onExit(code) })
  }

  const requestReload = (): void => {
    if (!shutdown.claimExit()) return
    const args = reloadArgs(process.argv.slice(2), active.id)
    const replace = (): void => { replaceProcess(args, active.id) }
    // Model selection is already durable; do not rewrite profile settings on reload.
    void dispose(false).then(replace, replace)
  }

  /** SIGTERM/SIGHUP share the one teardown and the one process exit. */
  const onSignal = createSignalExit(shutdown, code => { process.exit(code) })

  wireImageInput(editor, commandContext)
  editor.onSubmit = handleSubmit
  /** What a global shortcut does when the terminal consumes the key. */
  const shortcutActions: GlobalShortcutActions = {
    overlayOpen: () => tui.hasOverlay(),
    newSession: () => { void runCommand('/new') },
    pickSession: () => {
      void pickStoredSession(commandContext()).then(id => {
        if (id !== undefined && id !== active.id) return runCommand('/resume ' + id)
      }, error => { pushNotice('error', 'Could not open the session picker: ' + errorMessage(error)) })
    },
    cycleReasoning: () => {
      const ctx = commandContext()
      const selected = ctx.modelSelection.current
      reasoningCycle = reasoningCycle.then(() => cycleReasoningEffort(ctx, () =>
        active === ctx.active && !switching && !shutdown.disposed && !shutdown.exiting
        && modelSelection.current?.provider === selected?.provider
        && modelSelection.current?.model === selected?.model,
      )).catch(error => { pushNotice('error', 'Could not cycle reasoning effort: ' + errorMessage(error)) })
    },
    toggleToolPreviews: () => { renderer.toggleToolPreviews(); tui.requestRender() },
    jumpToLatest: () => { if (tui instanceof TuiAltScreen) tui.scrollToBottom() },
    clearInput: () => { editor.setText(''); tui.requestRender() },
    cancelCommand: () => commandDispatch.cancel(),
    cancelTurn: () => { active.agent.cancel({ kind: 'user' }) },
    exit: () => { requestExit(0) },
  }

  const handleGlobalInput = (data: string): { consume: true } | undefined => {
    const shortcut = globalShortcut(data, {
      running: active.agent.status === 'running',
      editorFocused: tui.getFocusedComponent() === editor,
      editorHasText: editor.getText() !== '',
      commandRunning: commandDispatch.running,
      scrolledAway: tui instanceof TuiAltScreen && !tui.isFollowingOutput && !tui.hasOverlay(),
    })
    const disposition = shortcutDisposition(shortcut, { switching, processingPaste: editor.isProcessingPaste })
    if (disposition === 'defer') {
      editor.deferInput(() => { if (!shutdown.disposed) handleGlobalInput(data) })
      return { consume: true }
    }
    if (disposition === 'swallow') return { consume: true }
    // Everything below is a real shortcut. A key without one (including a
    // dialog's Escape) belongs to the focused component.
    if (shortcut === undefined) return undefined
    return runGlobalShortcut(shortcut, shortcutActions)
  }
  tui.addInputListener(handleGlobalInput)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  try {
    warningGuard = holdProcessWarnings()
    // Host plugins log through `console`; a raw write lands inside the painted
    // frame and eats a status or prompt row. Failures become transcript notices;
    // routine info (a model listing loading on every catalogue refresh) stays off
    // the screen and goes to the opt-in debug trace.
    consoleGuard = holdConsoleOutput({
      onLine: (line) => {
        // A catalogue failure the Host repeats per route and per retry stays a
        // single notice; the copies after it are worth a trace, not a row.
        if (line.repeat !== true && (line.level === 'warn' || line.level === 'error')) {
          pushNotice(consoleTone(line.level), line.text)
          return
        }
        debug('console.' + line.level + (line.repeat === true ? ' (repeat)' : '') + ': ' + line.text)
      },
    })
    registerInteractions()
    warmTranscript()
    subscribeActive()
    tui.start()
    terminalTheme.connect(tui, () => { renderer.refreshPalette(); status.invalidate(); footer.invalidate(); frames.reset(); paintStatus(); tui.requestRender(true) })
    tui.setFocus(editor)
    tui.requestRender()
    void refreshContextWindow()
  }
  catch (error) {
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    await dispose()
    throw error
  }
  return {
    setDisplayModes: (thinkingDisplay, runCodeDisplay) => {
      if (shutdown.disposed) return
      renderer.setDisplayModes(thinkingDisplay, runCodeDisplay)
      frames.reset()
      tui.requestRender()
    },
    setMaxEntries: maxEntries => {
      if (shutdown.disposed || !renderer.setMaxEntries(maxEntries)) return
      frames.reset()
      tui.requestRender()
    },
    setImageThumbnails: enabled => {
      if (shutdown.disposed || config.showImageThumbnails === enabled) return
      config.showImageThumbnails = enabled
      tui.requestRender()
    },
    setTitle: next => {
      if (shutdown.disposed || next === title) return
      title = next
      // Both the header and the terminal tab carry the product title.
      syncWindowTitle()
      renderStatus()
    },
    activeSessionId: () => active.id,
    dispose: async () => {
      await dispose()
    },
  }
}
