import { spawn } from 'node:child_process'
import {
  Box,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { bindModelSelection, sameModelSelection } from '../runtime/model-selection.js'
import type {} from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DisplayMode, ResolvedConfig } from '../config.js'
import { createHostSession, readContextBreakdown, readContextMeter, restartHostSession, resumeHostSession, sessionAgentPreset, type AgentPresetService, type HostSession } from '../runtime/agent.js'
import { findLauncher, parseProfileArg, resumeHint } from '../runtime/launcher.js'
import { assertResumed, reloadArgs, RESUME_ENV } from '../runtime/reload.js'
import { skillRows } from '../runtime/skill-catalog.js'
import { createSessionMetricsMemo, type SessionMetrics, type SessionStats } from '../runtime/metrics.js'
import { showApproval, showQuestionBatch } from './dialogs.js'
import { approvalArguments, approvalReceipt } from './approval-preview.js'
import type { PendingAttachment } from '../runtime/attachments.js'
import { TuiAutocompleteProvider, type SessionReferenceService, type SkillSuggestion } from './autocomplete.js'
import { currentPreset, renderStatusRows, terminalWindowTitle } from './status-line.js'
import { createStatusRows } from './status-rows.js'
import { StatusBar } from './status-bar.js'
import { editorTheme, markdownTheme, type Palette } from './theme.js'
import { createTerminalTheme } from './terminal-theme.js'
import { debug } from '../debug.js'
import { globalShortcut } from './keymap.js'
import { LOCAL_COMMANDS } from './commands/catalog.js'
import type { CommandContext } from './commands/context.js'
import { runCommandLine } from './commands/router.js'
import { cycleReasoningEffort } from './commands/model.js'
import type { InteractionModeService as ModeService } from '../interaction-modes.js'
import type { AgentDefaultModelService, LLM, PermissionPresets, SessionProjectionsService, SkillsCatalog } from './commands/services.js'
import { openTuiSettings, showHostSettings } from './commands/settings.js'
import { errorMessage } from './commands/shared.js'
import { subscribeSessionEvents } from './session-events.js'
import { streamingRowKey, type TranscriptBlock, type TranscriptEntry } from './transcript.js'
import { frameCostMs, frameOverrunMs, nextFrameDelay, nextStreamInterval, STREAM_MIN_INTERVAL_MS, transcriptFrameChanged } from './stream-pacing.js'
import { TranscriptRenderer } from './transcript-renderer.js'
import { TranscriptMainScreen } from './transcript-main-screen.js'
import { WAIT_ROW_TICK_MS, WaitStatusLine, TurnStatus, type WaitRetry } from './waiting.js'
import { holdProcessWarnings, type WarningGuard } from './warnings.js'
import { consoleTone, holdConsoleOutput, type ConsoleGuard } from './console-guard.js'
import { scrollToEndLabel } from './scroll-indicator.js'
import { PromptEditor } from './prompt-editor.js'
import { wireImageInput } from './image-input.js'
import { SessionDrafts } from './session-drafts.js'
import { enqueuePrompt, submitDraft } from './prompt-submission.js'
import { pickStoredSession } from './commands/sessions.js'


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
function replaceProcess(args: readonly string[], sessionId: string): void {
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
  // The flag is the documented surface; the variable survives a launcher that
  // re-parses its own arguments, so a lost flag cannot start a fresh session.
  const env = { ...process.env, [RESUME_ENV]: sessionId }
  try {
    if (process.execve !== undefined) {
      process.execve(process.execPath, [process.execPath, entry, ...args], env)
    }
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: process.cwd(),
      env,
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
  const terminalTheme = createTerminalTheme(config.theme)
  const palette: Palette = terminalTheme.palette
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
    : new TranscriptMainScreen(terminal, false)
  // Every row uses the width the terminal reports: no stored horizontal inset,
  // so transcript, status and prompt share one left edge
  // and stay aligned through a resize.
  const header = new Text('', 0, 0)
  const headerGap = new Spacer(1)
  const composerGap = new Spacer(1)
  const status = new StatusBar(palette.dim(' · '))
  const footer = new StatusBar(palette.dim(' · '))
  const waitStatus = new WaitStatusLine(palette)
  // Native padding reserves the gutter while the input surface fills the width.
  const editor = new PromptEditor(tui, editorTheme(palette), palette.autocompleteSelection, palette.dialogBand)
  editor.placeholder = 'Ask DeepSeek Harness to do anything'
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
  // with the header, status and prompt.
  const transcript = new Box(0, 1)
  transcript.addChild(renderer.container)

  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(new VStack([
      { component: header, basis: 'auto' },
      { component: headerGap, basis: 'auto' },
      { component: new Spacer(1), basis: 'auto' },
      {
        component: new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'chain' }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: composerGap, basis: 'auto' },
      { component: waitStatus, basis: 'auto' },
      { component: editor, basis: 'auto' },
      { component: status, basis: 'auto' },
      { component: footer, basis: 'auto' },
    ]))
  } else {
    tui.addChild(header)
    tui.addChild(headerGap)
    tui.addChild(new Spacer(1))
    tui.addChild(transcript)
    tui.addChild(composerGap)
    tui.addChild(waitStatus)
    tui.addChild(editor)
    tui.addChild(status)
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
  const loadSkills = async (): Promise<readonly SkillSuggestion[]> => {
    const registry = skillRegistry()
    if (registry === undefined) return []
    try {
      const list = await registry.list({ cwd: active.agent.session.header.cwd ?? config.cwd, scope: active.agent })
      return skillRows(list).filter(skill => skill.userInvocable)
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
  const drafts = new SessionDrafts()
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
  const turnStatus = new TurnStatus()
  let waitTicker: ReturnType<typeof setInterval> | undefined
  let unsubscribeSession: (() => void) | undefined
  let interactionDisposers: Array<() => void> = []
  const interactionAbort = new AbortController()
  const attemptPositions = new Map<string, { turn: number; step: number }>()
  let contextWindow: number | undefined
  /** Output tokens one request reserves, as the compactor deducts them. */
  let contextReserved: number | undefined
  let modelSelection = bindModelSelection(active.agent)
  reasoningEffort = modelSelection.current?.reasoningEffort

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
    renderer.set(entries, localNotices, summaryCwd())
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
    renderer.set(entries, localNotices, summaryCwd())
    const pendingText = turnStatus.text()
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

  /** Clear live status and the last receipt when leaving the session. */
  const clearWait = (): void => {
    turnStatus.clear()
    stopWaitTicker()
  }

  /** Execution status follows Host events, never receipt or playback of text. */
  const beginWait = (retry?: WaitRetry): void => {
    turnStatus.begin(retry)
    if (waitTicker === undefined) waitTicker = setInterval(() => { scheduleTranscript(true) }, WAIT_ROW_TICK_MS)
    scheduleTranscript(true)
  }

  const pushNotice = (tone: 'info' | 'warning' | 'error' | 'success', text: string): void => {
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
   * Everything the context figures are read from: the routed capacity the meter
   * reported, the meter's own reading, the session-stats projection, and the log.
   */
  const contextInputs = () => {
    const projections = host.get('sessionProjections') as SessionProjectionsService | undefined
    const values = projections?.snapshot(active.agent.session, ['contextPressure', 'contextBreakdown', 'sessionStats']).values
    const meter = readContextMeter(projections, active.agent.session, contextReserved, values)
    return {
      projections,
      meter,
      // The routed request's own capacity wins, as on the Web meter; the model
      // catalog value only stands in before the first request is routed.
      window: meter.window ?? contextWindow,
      values,
      stats: values?.sessionStats as SessionStats | undefined,
      events: active.agent.session.snapshotEvents(),
    }
  }

  /**
   * The context figures both readers share: the status row prices them on every
   * event, and `/context` prints the same numbers on demand through the one
   * memoized fold, so a repaint between the two cannot make them disagree.
   * @returns the folded metrics and the meter's heuristic composition.
   */
  const readContextFigures = (): { readonly metrics: SessionMetrics; readonly breakdown: ReturnType<typeof readContextBreakdown> } => {
    const inputs = contextInputs()
    const metrics = metricsFold(inputs.events, inputs.stats, inputs.window, inputs.meter.reading)
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
    if (disposed || statusScheduled) return
    statusScheduled = true
    setImmediate(() => {
      statusScheduled = false
      paintStatus()
    })
  }

  // The chrome rows are deduplicated: an identical repaint only costs the fold.
  const statusRows = createStatusRows({ header, status, footer })

  const paintStatus = (): void => {
    if (disposed) return
    reasoningEffort = modelSelection.current?.reasoningEffort
    const options = active.agent.options
    const inputs = contextInputs()
    statusRows.reset()
    renderStatusRows(statusRows.rows, palette, {
      title,
      sessionId: active.id,
      cwd: summaryCwd() ?? config.cwd,
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
      stats: inputs.stats,
      events: inputs.events,
    }, metricsFold)
    if (!statusRows.changed) return
    syncWindowTitle()
    tui.requestRender()
  }

  const refreshContextWindow = async (): Promise<void> => {
    const session = active, owner = modelSelection
    const llm = host.get('llm') as LLM | undefined
    const current = modelSelection.current
    if (llm === undefined || current === undefined) return
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      if (active !== session || modelSelection !== owner || disposed || !sameModelSelection(owner.current, current)) return
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
        if (chunk !== undefined) turnStatus.resume()
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
      endWait: reason => { turnStatus.finish(reason); stopWaitTicker() },
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
        const args = approvalArguments(agent.session.snapshotEvents(), request.toolName, request.callId)
        const outcome = await showApproval(tui, palette, request, request.signal === undefined
          ? interactionAbort.signal
          : AbortSignal.any([request.signal, interactionAbort.signal]))
        if (!disposed && active.agent === agent) {
          const receipt = approvalReceipt(request.toolName, args, outcome)
          pushNotice(receipt.tone, receipt.text)
        }
        return outcome
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

  let reasoningCycle = Promise.resolve()

  const switchTo = async (next: () => Promise<HostSession>): Promise<void> => {
    await editor.whenInputIdle()
    if (switching || disposed) return
    switching = true
    editor.disableSubmit = true
    let opened: HostSession | undefined
    try {
      opened = await next()
      if (opened === active || disposed) return
      drafts.save(active.agent.session, { text: editor.getExpandedText(), attachments: pendingAttachments }, config.cwd, selectedPreset)
      disposeInteractions()
      clearSubscriptions()
      await active.dispose()
      if (disposed) return
      active = opened
      reasoningCycle = Promise.resolve()
      const draft = drafts.restore(active.id)
      editor.setText(draft.text)
      pendingAttachments = draft.attachments
      selectedPreset = sessionAgentPreset(active.agent.session) ?? selectedPreset
      entries = active.agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
      liveSeq = 0
      localNotices = []
      renderer.clear()
      tui.setFocus(editor)
      modelSelection = bindModelSelection(active.agent)
      contextWindow = undefined
      contextReserved = undefined
      registerInteractions()
      subscribeActive()
      void refreshContextWindow()
      pushNotice('info', 'Switched to ' + active.id)
    } catch (error) {
      pushNotice('error', 'Could not open the session: ' + errorMessage(error))
    } finally {
      if (opened !== undefined && opened !== active) {
        try { await opened.dispose() }
        catch (error) { pushNotice('error', 'Could not close the unopened session: ' + errorMessage(error)) }
      }
      switching = false
      editor.disableSubmit = false
    }
  }

  const openNewSession = async (cwd: string, preset?: string): Promise<HostSession> => {
    const presets = host.get('agentPresets') as AgentPresetService | undefined
    const targetPreset = presets === undefined ? preset : (await presets.resolve(preset)).id
    drafts.save(active.agent.session, { text: editor.getExpandedText(), attachments: pendingAttachments }, config.cwd, selectedPreset)
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
   */
  const commandContext = (): CommandContext => {
    const attachments = pendingAttachments
    const session = active, owner = modelSelection
    const isCurrent = (): boolean => active === session && modelSelection === owner && !switching && !disposed && !exiting
    return {
      host,
      config,
      palette,
      tui,
      active,
      restartSession: async expected => {
        if (expected !== active || switching || disposed) throw new Error('The active Session changed; choose permissions again.')
        let reopened: HostSession | undefined
        await switchTo(async () => { reopened = await restartHostSession(host, expected); return reopened })
        if (reopened === undefined || active !== reopened) throw new Error('Could not restore the Session after closing persistent shells; use /reload to retry.')
        return active
      },
      signal: interactionAbort.signal,
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
      setContextWindow: (tokens, reservedTokens) => {
        contextWindow = tokens
        contextReserved = reservedTokens
      },
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
  const runCommand = (line: string): Promise<void> => runCommandLine(line, {
    context: commandContext,
    switchTo,
    openNewSession,
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
    if (trimmed === 'exit' || trimmed === 'quit') {
      requestExit(0)
      return
    }
    if (trimmed.startsWith('/')) {
      editor.setText('')
      void runCommand(trimmed)
      return
    }
    submitDraft(text, editor, () => sendPrompt(trimmed))
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
    const replace = (): void => { replaceProcess(args, active.id) }
    // Model selection is already durable; do not rewrite profile settings on reload.
    void dispose(false).then(replace, replace)
  }

  const onSignal = (): void => {
    void dispose().finally(() => { process.exit(143) })
  }

  const dispose = async (reportSession = true): Promise<void> => {
    if (disposed) return
    disposed = true
    terminalTheme.dispose()
    editor.cancelPendingInput()
    interactionAbort.abort(new Error('native-tui: terminal disposed'))
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

  wireImageInput(editor, commandContext)
  editor.onSubmit = handleSubmit
  const handleGlobalInput = (data: string): { consume: true } | undefined => {
    const shortcut = globalShortcut(data, {
      running: active.agent.status === 'running',
      editorFocused: tui.getFocusedComponent() === editor,
      editorHasText: editor.getText() !== '',
    })
    if (shortcut !== undefined && editor.isProcessingPaste && shortcut !== 'exit' && shortcut !== 'cancel-turn') {
      editor.deferInput(() => { if (!disposed) handleGlobalInput(data) })
      return { consume: true }
    }
    if (switching && shortcut !== 'exit' && shortcut !== 'cancel-turn') return { consume: true }
    if (shortcut === undefined) return undefined
    if (shortcut === 'new-session' || shortcut === 'pick-session') {
      if (tui.hasOverlay() || switching) return undefined
      if (shortcut === 'new-session') void runCommand('/new')
      else void pickStoredSession(commandContext()).then(id => {
        if (id !== undefined && id !== active.id) return runCommand('/resume ' + id)
      }, error => { pushNotice('error', 'Could not open the session picker: ' + errorMessage(error)) })
      return { consume: true }
    }
    if (shortcut === 'cycle-reasoning') {
      if (tui.hasOverlay()) return undefined
      const ctx = commandContext()
      const selected = ctx.modelSelection.current
      reasoningCycle = reasoningCycle.then(() => cycleReasoningEffort(ctx, () =>
        active === ctx.active && !switching && !disposed && !exiting
        && modelSelection.current?.provider === selected?.provider
        && modelSelection.current?.model === selected?.model,
      )).catch(error => { pushNotice('error', 'Could not cycle reasoning effort: ' + errorMessage(error)) })
      return { consume: true }
    }
    if (shortcut === 'toggle-tool-previews') {
      if (tui.hasOverlay()) return undefined
      renderer.toggleToolPreviews()
      tui.requestRender()
      return { consume: true }
    }
    if (shortcut === 'clear-input') {
      editor.setText('')
      tui.requestRender()
      return { consume: true }
    }
    if (shortcut === 'cancel-turn') {
      if (tui.hasOverlay()) return undefined
      active.agent.cancel({ kind: 'user' })
      return { consume: true }
    }
    requestExit(0)
    return { consume: true }
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
    terminalTheme.connect(tui, () => { renderer.refreshPalette(); paintStatus(); tui.requestRender(true) })
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
