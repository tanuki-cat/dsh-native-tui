import { spawn } from 'node:child_process'
import {
  Box,
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
import { findLauncher, parseProfileArg, resumeHint } from '../runtime/launcher.js'
import { reloadArgs } from '../runtime/reload.js'
import { createSessionMetricsMemo, type SessionStats } from '../runtime/metrics.js'
import { showApproval, showQuestionBatch } from './dialogs.js'
import type { PendingAttachment } from '../runtime/attachments.js'
import { TuiAutocompleteProvider, type SessionReferenceService, type SkillSuggestion } from './autocomplete.js'
import { currentPreset, renderStatusRows, terminalWindowTitle } from './status-line.js'
import { createPalette, editorTheme, markdownTheme, type Palette } from './theme.js'
import { debug } from '../debug.js'
import { globalShortcut } from './keymap.js'
import { LOCAL_COMMANDS } from './commands/catalog.js'
import type { CommandContext } from './commands/context.js'
import { runCommandLine } from './commands/router.js'
import type { AgentDefaultModelService, LLM, SessionProjectionsService, SkillsCatalog } from './commands/services.js'
import { openTuiSettings, showHostSettings } from './commands/settings.js'
import { errorMessage } from './commands/shared.js'
import { subscribeSessionEvents } from './session-events.js'
import { streamingRowKey, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import { frameCostMs, frameOverrunMs, nextFrameDelay, nextStreamInterval, STREAM_MIN_INTERVAL_MS, transcriptFrameChanged } from './stream-pacing.js'
import { TranscriptRenderer } from './transcript-renderer.js'
import { WAIT_ROW_TICK_MS, WaitStatusLine, waitingText, type WaitRetry } from './waiting.js'
import { holdProcessWarnings, type WarningGuard } from './warnings.js'
import { consoleTone, holdConsoleOutput, type ConsoleGuard } from './console-guard.js'
import { Rule } from './rule.js'
import { scrollToEndLabel } from './scroll-indicator.js'
import { PromptEditor } from './prompt-editor.js'


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
 * Replace the running Node process with a fresh dsh invocation. `execve` keeps
 * the PID and inherited terminal; platforms without it use a child process
 * that owns the same stdio.
 * @param args - launcher arguments after the entry script.
 */
function replaceProcess(args: readonly string[]): void {
  const entry = process.argv[1]
  if (entry === undefined) {
    process.stderr.write('native-tui: reload failed: cannot locate the dsh entry script\n')
    process.exit(1)
  }
  try {
    process.stdout.write('\nReloading dsh…\n')
  } catch {
    // A closed stdout must not prevent the replacement.
  }
  try {
    if (process.execve !== undefined) {
      process.execve(process.execPath, [process.execPath, entry, ...args], process.env)
    }
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', error => {
      process.stderr.write('native-tui: reload failed: ' + error.message + '\n')
      process.exit(1)
    })
    child.once('exit', code => { process.exit(code ?? 1) })
  } catch (error) {
    process.stderr.write('native-tui: reload failed: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exit(1)
  }
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
  let reasoningEffort: string | undefined
  const terminal = new ProcessTerminal()
  const tui = config.fullscreen
    ? new TuiAltScreen(terminal, false, undefined, {
      mouse: true,
      // The fullscreen viewport owns its scroll offset, so a reader who scrolled
      // up has no way back without a target to click. pi-tui composites this on
      // the last row of the follow-end primary scroll view only while that view
      // is away from its end, and resumes following on a click.
      scrollToEndIndicator: () => scrollToEndLabel(palette),
    })
    : new TuiMainScreen(terminal, false)
  // Every row uses the width the terminal reports: no stored horizontal inset,
  // so transcript, status, prompt, and the divider rules share one left edge
  // and stay aligned through a resize.
  const header = new Text('', 0, 0)
  const headerRule = new Rule(text => palette.dim(text))
  const statusRule = new Rule(text => palette.reasoning(reasoningEffort)(text))
  const status = new Text('', 0, 0)
  const footer = new Text('', 0, 0)
  const waitStatus = new WaitStatusLine(palette)
  // The native padding reserves the prompt gutter without shifting the full-width borders.
  const editor = new PromptEditor(tui, editorTheme(palette, () => reasoningEffort))
  const markdown = markdownTheme(palette)
  const renderer = new TranscriptRenderer({
    showReasoning: config.showReasoning,
    thinkingDisplay: config.thinkingDisplay,
    runCodeDisplay: config.runCodeDisplay,
    maxEntries: config.maxTranscriptEntries,
    palette,
    markdown,
  })

  // Vertical breathing room only: the transcript shares the full-width column
  // with the header, status, prompt, and rules.
  const transcript = new Box(0, 1)
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
      { component: waitStatus, basis: 'auto' },
      { component: editor, basis: 'auto' },
      { component: footer, basis: 'auto' },
    ]))
  } else {
    tui.addChild(header)
    tui.addChild(headerRule)
    tui.addChild(new Spacer(1))
    tui.addChild(transcript)
    tui.addChild(statusRule)
    tui.addChild(status)
    tui.addChild(waitStatus)
    tui.addChild(editor)
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
  /** Holds Node warnings while the UI owns the screen; released once it is restored. */
  let warningGuard: WarningGuard | undefined
  /** Holds Host/dependency console output for the same span. */
  let consoleGuard: ConsoleGuard | undefined
  let reportedSession = false
  let exiting = false
  let switching = false
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
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined
  /** When the pending frame is due, so a late one can measure what held the loop. */
  let frameDueAt: number | undefined
  let transcriptInterval = STREAM_MIN_INTERVAL_MS
  /** The previous frame was a cold rebuild, so its paint cost is not steady cost. */
  let coldPaintPending = false
  /** Bumped whenever a rebuild changes the rows the transcript paints. */
  let transcriptRevision = 0
  /** What the last painted frame showed, so an identical one can be skipped. */
  let painted = { revision: -1, wait: '' }
  /** performance.now() of the last frame that actually requested a paint. */
  let lastPaintAt = 0
  /** Epoch ms the active turn began, undefined when idle. */
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
  reasoningEffort = modelSelection.current?.reasoningEffort
  let disposeModelSelection: (() => void) | undefined
  disposeModelSelection = installModelSelection(active.agent.ctx, modelSelection)

  const summaryCwd = (): string | undefined => active.agent.session.header.cwd ?? config.cwd

  /**
   * Name the workspace in the terminal tab.
   *
   * Written only when the label changes: OSC 0 is a terminal-wide side effect,
   * and the status block repaints on every Session event.
   */
  const syncWindowTitle = (): void => {
    const next = terminalWindowTitle(title, summaryCwd() ?? config.cwd)
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

  /**
   * Build the initial transcript before the first frame paints it.
   *
   * Opening or resuming a long session otherwise creates every row on the first
   * frame, which lands exactly when output starts; warming here pays that
   * component construction once, before the terminal shows anything. The paint
   * itself is unchanged.
   */
  const warmTranscript = (): void => {
    if (entries.length === 0) return
    renderer.set(entries, localNotices)
    renderer.container.render(Math.max(1, terminal.columns))
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
    // Measured before anything runs, so it covers only time the loop spent on
    // work other than this frame: delivery of other events, timers, and above
    // all the previous paint. Taking it after the rebuild would charge that
    // work twice.
    const slippedMs = frameOverrunMs(frameDueAt, performance.now())
    frameDueAt = undefined
    const started = performance.now()
    renderer.set(entries, localNotices)
    const pending = waitingBlock()
    const pendingText = pending === undefined ? '' : pending.text
    waitStatus.setText(pendingText)
    if (renderer.contentChanged) transcriptRevision += 1
    const revision = transcriptRevision
    // Bound the next rebuild before pacing it.
    if (renderer.retainedFrom > 0) entries = entries.slice(renderer.retainedFrom)
    const rebuildMs = performance.now() - started
    const sincePaint = performance.now() - lastPaintAt
    // The previous frame's whole cost is the slip plus this rebuild: pi-tui's
    // cursor resolution, line resets and differential write all happen after
    // this function returns, so the only way to see them is the next frame's
    // lateness. That lateness also contains unrelated loop work, so the pacer
    // caps it at the interval the frame ran on; one stall doubles the interval
    // once instead of commanding an arbitrary backoff, while a paint that keeps
    // overrunning still doubles it every frame until twice its cost fits.
    // Pacing on the rebuild alone let a 2000-row window paint every 33 ms at
    // ~90 ms a paint, which starved the loop that reads the model stream and
    // stretched the timings the decode rate is measured from — the fall a long
    // session showed in tok/s.
    // A cold rebuild re-creates every row (session open, resume, density
    // change). Letting that one-off cost steer the pacer would hold streaming at
    // twice its duration for seconds, which reads as stutter; resume from the
    // floor instead and let the next frames measure the steady cost.
    const cold = renderer.coldRebuild
    const frameMs = frameCostMs(rebuildMs, coldPaintPending ? 0 : slippedMs, transcriptInterval)
    transcriptInterval = cold || coldPaintPending
      ? STREAM_MIN_INTERVAL_MS
      : nextStreamInterval(transcriptInterval, frameMs)
    coldPaintPending = cold
    debug(`stream frame: rebuild=${rebuildMs.toFixed(1)}ms slipped=${slippedMs.toFixed(1)}ms cost=${frameMs.toFixed(1)}ms sincePaint=${sincePaint.toFixed(1)}ms interval=${String(transcriptInterval)}ms live=${String(renderer.liveContentLength)}`)
    const mark = { revision, wait: pendingText }
    if (transcriptFrameChanged(painted, mark)) {
      painted = mark
      lastPaintAt = performance.now()
      tui.requestRender()
    }
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
      // An inline frame has no scheduled due time and charges no timer slip.
      frameDueAt = undefined
      renderTranscript()
      return
    }
    if (transcriptTimer !== undefined) return
    const delay = nextFrameDelay(transcriptInterval, elapsed)
    // Due time, so the frame can tell scheduling from blocking: anything past
    // it is work that held the loop between two frames.
    frameDueAt = performance.now() + delay
    transcriptTimer = setTimeout(() => {
      transcriptTimer = undefined
      renderTranscript()
    }, delay)
  }

  /** Stop the one-second repaint that keeps the wait row's elapsed time live. */
  const stopWaitTicker = (): void => {
    if (waitTicker === undefined) return
    clearInterval(waitTicker)
    waitTicker = undefined
  }

  /** Clear execution status when the turn settles or the session changes. */
  const clearWait = (): void => {
    waitSince = undefined
    waitRetry = undefined
    stopWaitTicker()
  }

  /** Execution status follows Host events, never receipt or playback of text. */
  const beginWait = (retry?: WaitRetry): void => {
    waitSince ??= Date.now()
    waitRetry = retry
    if (waitTicker === undefined) waitTicker = setInterval(() => { scheduleTranscript(true) }, WAIT_ROW_TICK_MS)
    scheduleTranscript(true)
  }

  const waitingBlock = (): (TranscriptBlock & { readonly kind: 'waiting' }) | undefined => {
    const now = Date.now()
    if (waitSince === undefined) return undefined
    return { kind: 'waiting', text: waitingText(waitSince, waitRetry, now) }
  }

  const pushNotice = (tone: 'info' | 'warning' | 'error', text: string): void => {
    const streamKey = streamingRowKey(entries)
    localNotices.push({
      kind: 'notice',
      tone,
      text,
      afterSeq: lastDurableSeq() ?? 0,
      ...(streamKey === undefined ? {} : { afterStreamKey: streamKey }),
    })
    if (localNotices.length > MAX_NOTICES) localNotices = localNotices.slice(-MAX_NOTICES)
    scheduleTranscript(true)
  }

  /** One fold per application, so a repaint over an unchanged log is free. */
  const metricsFold = createSessionMetricsMemo()

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
    if (disposed || statusScheduled) return
    statusScheduled = true
    setImmediate(() => {
      statusScheduled = false
      paintStatus()
    })
  }

  const paintStatus = (): void => {
    if (disposed) return
    reasoningEffort = modelSelection.current?.reasoningEffort
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
      reasoningEffort,
      preset: currentPreset(host.get('agentPresets') as AgentPresetService | undefined, active.agent.ctx),
      attachmentCount: pendingAttachments.length,
      // The routed request's own capacity wins, as on the Web meter; the model
      // catalog value only stands in before the first request is routed.
      contextWindow: meter.window ?? contextWindow,
      contextMeter: meter.reading,
      stats: projections?.stateOf(active.agent.session, 'sessionStats') as SessionStats | undefined,
      events: active.agent.session.snapshotEvents(),
    }, metricsFold)
    syncWindowTitle()
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
        if (chunk !== undefined) waitRetry = undefined
        if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
          debug(`stream chunk: ${chunk.type} ${String(chunk.text.length)} chars`)
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
    reload: requestReload,
    preset: {
      current: () => selectedPreset,
      select: id => { selectedPreset = id },
    },
    skills: loadSkills,
  })

  const handleSubmit = (text: string): void => {
    if (exiting) return
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

  const requestReload = (): void => {
    if (exiting || disposed) return
    exiting = true
    const args = reloadArgs(process.argv.slice(2), active.id)
    const replace = (): void => { replaceProcess(args) }
    const current = modelSelection.current
    if (current !== undefined) {
      try {
        // The event map augmentation lives in a package this entry point does
        // not import; the Host accepts the same record from its session API.
        const session = active.agent.session as unknown as {
          append(type: string, data: unknown): unknown
        }
        session.append('model/selection', current)
      } catch {
        // A session that refuses the record still reloads; its model may reset.
      }
    }
    // Persisting the default model here would call the config editor, which
    // rewrites the profile patch from the running config and can undo a
    // restart-only setting the user just saved. The session event above is
    // enough to restore the model after the replacement.
    void dispose(false).then(replace, replace)
  }

  const onSignal = (): void => {
    void dispose().finally(() => { process.exit(143) })
  }

  const dispose = async (reportSession = true): Promise<void> => {
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
      const profile = parseProfileArg(process.argv.slice(2))
      let resume = resumeHint(profile, undefined, active.id)
      try {
        resume = resumeHint(profile, await findLauncher(profile), active.id)
      }
      catch {
        // Keep the explicit fallback when the launcher lookup fails.
      }
      try {
        process.stdout.write('\nSession: ' + active.id + '\nResume: ' + resume + '\n')
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
    if (shortcut === 'toggle-write-preview') {
      if (tui.hasOverlay()) return undefined
      renderer.toggleWritePreview()
      tui.requestRender()
      return { consume: true }
    }
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
    warningGuard = holdProcessWarnings()
    // Host plugins log through `console`; a raw write lands inside the painted
    // frame and eats a status or prompt row. Failures become transcript notices;
    // routine info (a model listing loading on every catalogue refresh) stays off
    // the screen and goes to the opt-in debug trace.
    consoleGuard = holdConsoleOutput({
      onLine: (line) => {
        if (line.level === 'warn' || line.level === 'error') {
          pushNotice(consoleTone(line.level), line.text)
          return
        }
        debug('console.' + line.level + ': ' + line.text)
      },
    })
    registerInteractions()
    warmTranscript()
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
      // Both the header and the terminal tab carry the product title.
      syncWindowTitle()
      renderStatus()
    },
    dispose: async () => {
      await dispose()
    },
  }
}
