import {
  Box,
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
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DisplayMode, ResolvedConfig } from '../config.js'
import { createHostSession, readContextMeter, resumeHostSession, sessionAgentPreset, sessionModelSelection, type AgentPresetService, type HostSession } from '../runtime/agent.js'
import type { SessionStats } from '../runtime/metrics.js'
import { showApproval, showQuestionBatch } from './dialogs.js'
import type { PendingAttachment } from '../runtime/attachments.js'
import { TuiAutocompleteProvider, type SessionReferenceService, type SkillSuggestion } from './autocomplete.js'
import { currentPreset, renderStatusRows } from './status-line.js'
import { createPalette, editorTheme, markdownTheme, type Palette } from './theme.js'
import { globalShortcut } from './keymap.js'
import { LOCAL_COMMANDS } from './commands/catalog.js'
import type { CommandContext } from './commands/context.js'
import { runCommandLine } from './commands/router.js'
import type { AgentDefaultModelService, LLM, SessionProjectionsService, SkillsCatalog } from './commands/services.js'
import { openTuiSettings, showHostSettings } from './commands/settings.js'
import { errorMessage } from './commands/shared.js'
import { subscribeSessionEvents } from './session-events.js'
import { liveChunkHasOutput, nextFrameDelay, nextStreamInterval, STREAM_MIN_INTERVAL_MS, STREAM_MS_PER_CHAR, transcriptFrameChanged, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import { TranscriptRenderer } from './transcript-renderer.js'
import { WAIT_ROW_DELAY_MS, waitingText, waitingVisible, type WaitRetry } from './waiting.js'
import { Rule } from './rule.js'


/** Terminal application lifecycle. */
export interface TerminalApp {
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void
  setMaxEntries(maxEntries: number): void
  /** Replace the product title shown in the header and status row. */
  setTitle(title: string): void
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
  const palette: Palette = createPalette(config.theme)
  const terminal = new ProcessTerminal()
  const tui = config.fullscreen
    ? new TuiAltScreen(terminal, false, undefined, { mouse: true })
    : new TuiMainScreen(terminal, false)
  const header = new Text('', 2, 0)
  const headerRule = new Rule(text => palette.dim(text), 2)
  const statusRule = new Rule(text => palette.dim(text), 2)
  const status = new Text('', 2, 0)
  const footer = new Text('', 2, 0)
  const editor = new Editor(tui, editorTheme(palette))
  // The editor paints its own top/bottom border at the full component width;
  // wrapping it keeps that border aligned with the inset rules and status text.
  const editorBox = new Box(2, 0)
  editorBox.addChild(editor)
  const markdown = markdownTheme(palette)
  const renderer = new TranscriptRenderer({
    showReasoning: config.showReasoning,
    thinkingDisplay: config.thinkingDisplay,
    runCodeDisplay: config.runCodeDisplay,
    maxEntries: config.maxTranscriptEntries,
    palette,
    markdown,
  })
  let thinkingDisplayMode = config.thinkingDisplay

  // One inset content column: transcript bands, rules, status, and editor all
  // share the same left/right margin so the page breathes like pi agent's.
  const transcript = new Box(2, 1)
  transcript.addChild(renderer.container)

  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(new VStack([
      { component: header, basis: 'auto' },
      { component: headerRule, basis: 'auto' },
      { component: new Spacer(1), basis: 'auto' },
      {
        component: new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'chain' }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: statusRule, basis: 'auto' },
      { component: status, basis: 'auto' },
      { component: new Spacer(1), basis: 'auto' },
      { component: editorBox, basis: 'auto' },
      { component: footer, basis: 'auto' },
    ]))
  } else {
    tui.addChild(header)
    tui.addChild(headerRule)
    tui.addChild(new Spacer(1))
    tui.addChild(transcript)
    tui.addChild(statusRule)
    tui.addChild(status)
    tui.addChild(new Spacer(1))
    tui.addChild(editorBox)
    tui.addChild(footer)
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
  let title = config.title
  let selectedPreset: string | undefined = sessionAgentPreset(active.agent.session)
    ?? config.agentPreset
    ?? (host.get('agentPresets') as AgentPresetService | undefined)?.defaultId
  let liveSeq = 0
  let entries: TranscriptEntry[] = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
  let localNotices: TranscriptBlock[] = []
  let pendingAttachments: PendingAttachment[] = []
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined
  let transcriptInterval = STREAM_MIN_INTERVAL_MS
  /** Bumped whenever a rebuild changes the rows the transcript paints. */
  let transcriptRevision = 0
  /** What the last painted frame showed, so an identical one can be skipped. */
  let painted = { revision: -1, wait: '' }
  /** performance.now() of the last frame that actually requested a paint. */
  let lastPaintAt = 0
  /** Epoch ms the in-flight model request began, undefined when none is pending. */
  let waitSince: number | undefined
  let waitRetry: WaitRetry | undefined
  let waitTicker: ReturnType<typeof setInterval> | undefined
  let unsubscribeSession: (() => void) | undefined
  let interactionDisposers: Array<() => void> = []
  const interactionAbort = new AbortController()
  const attemptPositions = new Map<string, { turn: number; step: number }>()
  let contextWindow: number | undefined
  /** Output tokens one request reserves, as the compactor deducts them. */
  let contextReserved: number | undefined
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

  /**
   * Rebuild the transcript and paint it.
   *
   * Rebuilds are scheduled on a cadence while streaming and once a second while
   * waiting, so a frame can land with nothing new to show. The revision comes
   * from the rebuild itself, which lets such a frame skip the repaint instead of
   * writing an identical screen.
   */
  const renderTranscript = (): void => {
    if (disposed) return
    const started = performance.now()
    const pending = waitingBlock()
    const pendingText = pending === undefined ? '' : pending.text
    renderer.set(entries, pending === undefined ? localNotices : [...localNotices, pending])
    if (renderer.contentChanged) transcriptRevision += 1
    const revision = transcriptRevision
    // Bound the next rebuild, then pace it: the rebuild excludes pi-tui's later
    // container render, whose dominant cost is the growing live Markdown.
    if (renderer.retainedFrom > 0) entries = entries.slice(renderer.retainedFrom)
    const frameMs = performance.now() - started + renderer.liveContentLength * STREAM_MS_PER_CHAR
    transcriptInterval = nextStreamInterval(transcriptInterval, frameMs)
    const revealing = renderer.liveRevealPending
    const mark = { revision, wait: pendingText }
    if (transcriptFrameChanged(painted, mark, revealing)) {
      painted = mark
      lastPaintAt = performance.now()
      tui.requestRender()
    }
    // A local reveal has no incoming chunk to re-arm the timer, so it drives
    // its own frames until the whole block is visible.
    if (revealing) scheduleTranscript()
  }

  /**
   * Ask for a transcript frame.
   * @param immediate - paint now instead of waiting for the next stream frame.
   *   Bursts are still coalesced so one interval never paints twice.
   */
  const scheduleTranscript = (immediate = false): void => {
    if (disposed) return
    const elapsed = performance.now() - lastPaintAt
    if (immediate && elapsed >= transcriptInterval) {
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
    }, nextFrameDelay(transcriptInterval, elapsed))
  }

  /** Stop the one-second repaint that keeps the wait row's elapsed time live. */
  const stopWaitTicker = (): void => {
    if (waitTicker === undefined) return
    clearInterval(waitTicker)
    waitTicker = undefined
  }

  /** Forget the pending request: it answered, or the turn settled. */
  const clearWait = (): void => {
    waitSince = undefined
    waitRetry = undefined
    stopWaitTicker()
  }

  /**
   * Record that a request is in flight and repaint the row once a second, so a
   * reader can tell a slow model from a turn that is no longer moving.
   */
  const beginWait = (): void => {
    waitSince = Date.now()
    // Repaint on the same cadence the row becomes reportable, so it shows on time.
    if (waitTicker === undefined) waitTicker = setInterval(() => { scheduleTranscript(true) }, WAIT_ROW_DELAY_MS)
  }

  const waitingBlock = (): (TranscriptBlock & { readonly kind: 'waiting' }) | undefined => {
    const now = Date.now()
    if (waitSince === undefined || !waitingVisible(waitSince, waitRetry, now)) return undefined
    return { kind: 'waiting', text: waitingText(waitSince, waitRetry, now) }
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
    const meter = readContextMeter(projections, active.agent.session, contextReserved)
    renderStatusRows({ header, status, footer }, palette, {
      title,
      sessionId: active.id,
      cwd: summaryCwd() ?? config.cwd,
      running: active.agent.status === 'running',
      provider: modelSelection.current?.provider ?? options.provider ?? 'deepseek-official',
      model: modelSelection.current?.model ?? options.model ?? 'deepseek-flash',
      reasoningEffort: modelSelection.current?.reasoningEffort,
      preset: currentPreset(host.get('agentPresets') as AgentPresetService | undefined, active.agent.ctx),
      attachmentCount: pendingAttachments.length,
      // The routed request's own capacity wins, as on the Web meter; the model
      // catalog value only stands in before the first request is routed.
      contextWindow: meter.window ?? contextWindow,
      contextMeter: meter.reading,
      stats: projections?.stateOf(active.agent.session, 'sessionStats') as SessionStats | undefined,
      events: active.agent.session.snapshotEvents(),
    })
    tui.requestRender()
  }

  const refreshContextWindow = async (): Promise<void> => {
    const llm = host.get('llm') as LLM | undefined
    const current = modelSelection.current
    if (llm === undefined || current === undefined) return
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      contextWindow = info.context?.contextWindow
      contextReserved = info.defaultMaxTokens
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
      appendEntry: entry => {
        const chunk = entry.type === 'live' ? entry.event.data.chunk : undefined
        // A bare block-start creates an empty live row; keep the wait row until
        // the chunk produces something the reader can actually see.
        if (chunk !== undefined && waitSince !== undefined
          && liveChunkHasOutput(chunk, thinkingDisplayMode !== 'hidden')) clearWait()
        entries.push(entry)
        // Start the placeholder or first revealed chunk without waiting for the
        // current transcript timer, which may be up to 100ms away.
        if (chunk?.type === 'block-start' && chunk.blockType === 'reasoning' && thinkingDisplayMode !== 'hidden') {
          scheduleTranscript(true)
        }
        else if (chunk?.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
          scheduleTranscript(true)
        }
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
      retryScheduled: retry => {
        waitRetry = retry
        beginWait()
      },
      endWait: clearWait,
    })
    scheduleTranscript(true)
    renderStatus()
  }

  const clearSubscriptions = (): void => {
    unsubscribeSession?.()
    unsubscribeSession = undefined
    clearWait()
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
      contextReserved = undefined
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
    setContextWindow: (tokens, reservedTokens) => {
      contextWindow = tokens
      contextReserved = reservedTokens
    },
    persistSelection,
  })

  /**
   * Route one `/` line through the command dispatcher. Only what a handler
   * cannot reach through its command context is injected here: the session
   * switch, prompts, the transcript reset, and the preset record.
   */
  const runCommand = (line: string): Promise<void> => runCommandLine(line, {
    context: commandContext,
    switchTo,
    sendPrompt,
    clearTranscript: () => {
      entries = []
      localNotices = []
      renderer.clear()
      scheduleTranscript(true)
    },
    exit: requestExit,
    preset: {
      current: () => selectedPreset,
      select: id => { selectedPreset = id },
    },
    skills: loadSkills,
  })

  const handleSubmit = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '' && pendingAttachments.length === 0) return
    editor.setText('')
    if (trimmed === 'exit' || trimmed === 'quit') {
      requestExit(0)
      return
    }
    if (trimmed.startsWith('/')) {
      void runCommand(trimmed)
      return
    }
    sendPrompt(trimmed)
  }

  const requestExit = (code: number): void => {
    if (exiting || disposed) return
    exiting = true
    void dispose().then(() => { onExit(code) }, () => { onExit(code) })
  }

  const onSignal = (): void => {
    void dispose().finally(() => { process.exit(143) })
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    interactionAbort.abort(new Error('native-tui: terminal disposed'))
    disposeModelSelection?.()
    disposeModelSelection = undefined
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
    if (!reportedSession) {
      reportedSession = true
      try {
        process.stdout.write('\nSession: ' + active.id + '\nResume: dsh --profile tui --resume ' + active.id + '\n')
      }
      catch {
        // A closed stdout must not turn a normal exit into a failure.
      }
    }
    await active.dispose()
  }

  editor.onSubmit = handleSubmit
  tui.addInputListener(data => {
    const shortcut = globalShortcut(data, {
      running: active.agent.status === 'running',
      editorFocused: tui.getFocusedComponent() === editor,
      editorHasText: editor.getText() !== '',
    })
    if (shortcut === undefined) return undefined
    if (shortcut === 'clear-input') {
      editor.setText('')
      return { consume: true }
    }
    if (shortcut === 'cancel-turn') {
      if (tui.hasOverlay()) return undefined
      active.agent.cancel({ kind: 'user' })
      return { consume: true }
    }
    requestExit(0)
    return { consume: true }
  })
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  try {
    registerInteractions()
    subscribeActive()
    tui.start()
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
      if (disposed) return
      thinkingDisplayMode = thinkingDisplay
      renderer.setDisplayModes(thinkingDisplay, runCodeDisplay)
      tui.requestRender()
    },
    setMaxEntries: maxEntries => {
      if (disposed) return
      renderer.setMaxEntries(maxEntries)
      tui.requestRender()
    },
    setTitle: next => {
      if (disposed || next === title) return
      title = next
      renderStatus()
    },
    dispose: async () => {
      await dispose()
    },
  }
}
