/**
 * Application-level lifecycle for the terminal UI.
 *
 * The terminal surface, its frame pacing, the shared teardown, the resume lines
 * printed on exit, and the reload handoff live here, so `app.ts` keeps only the
 * wiring that needs live Session state.
 *
 * @module dsh-native-tui/ui/app-lifecycle
 */

import { spawn } from 'node:child_process'
import {
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
} from '@earendil-works/pi-tui'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { ResolvedConfig } from '../config.js'
import { debug } from '../debug.js'
import { findLauncher, parseProfileArg, resumeHint } from '../runtime/launcher.js'
import { RESUME_ENV } from '../runtime/reload.js'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { TimedAltScreen, TimedMainScreen } from './paint-timing.js'
import { PromptEditor } from './prompt-editor.js'
import { ScrollToLatest } from './scroll-indicator.js'
import { StatusBar } from './status-bar.js'
import { nextFrameDelay, StreamPacer, transcriptFrameChanged } from './stream-pacing.js'
import { editorTheme, markdownTheme, type Palette } from './theme.js'
import { createTerminalTheme } from './terminal-theme.js'
import type { TranscriptBlock, TranscriptEntry } from './transcript.js'
import { TranscriptBody } from './transcript-body.js'
import { TranscriptRenderer } from './transcript-renderer.js'
import { WAIT_ROW_TICK_MS, TurnStatus, WaitStatusLine, type WaitRetry } from './waiting.js'

/** Exit status a signal-triggered shutdown reports. */
export const SIGNAL_EXIT_CODE = 143

/**
 * Replace the running Node process with a fresh dsh invocation. `execve` keeps
 * the PID and inherited terminal; platforms without it use a child process
 * that owns the same stdio.
 * @param args - launcher arguments after the entry script.
 * @param sessionId - Session the replacement must resume.
 */
export function replaceProcess(args: readonly string[], sessionId: string): void {
  const entry = process.argv[1]
  if (entry === undefined) {
    process.stderr.write('native-tui: reload failed: cannot locate the dsh entry script\n')
    process.exit(1)
  }
  try {
    process.stdout.write('\nReloading dsh…\n')
  }
  catch {
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
  }
  catch (error) {
    process.stderr.write('native-tui: reload failed: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exit(1)
  }
}

/**
 * The two lines a finished terminal prints so the operator can resume.
 *
 * The Session id comes from persisted Host state and the resume line embeds the
 * launcher, so neither may carry terminal instructions or OS commands-of-opportunity.
 * @param sessionId - Session that was on screen.
 * @param resume - command that reopens it.
 * @returns the exit summary, including its leading and trailing newline.
 */
export function formatExitSummary(sessionId: string, resume: string): string {
  return '\nSession: ' + sanitizeTerminalText(sessionId) + '\nResume: ' + sanitizeTerminalText(resume) + '\n'
}

/**
 * The pi-tui tree and hosts one terminal application paints through.
 *
 * Every row uses the width the terminal reports: no stored horizontal inset, so
 * transcript, status and prompt share one left edge and stay aligned through a
 * resize.
 */
export interface TerminalSurface {
  readonly terminal: ProcessTerminal
  readonly tui: TimedAltScreen | TimedMainScreen
  readonly terminalTheme: ReturnType<typeof createTerminalTheme>
  readonly palette: Palette
  readonly header: Text
  readonly editor: PromptEditor
  readonly waitStatus: WaitStatusLine
  readonly status: StatusBar
  readonly footer: StatusBar
  readonly renderer: TranscriptRenderer
  readonly transcript: TranscriptBody
}

/**
 * Build the terminal and the components every frame paints.
 * @param config - resolved terminal configuration.
 * @returns the mounted component tree; callers own its lifecycle.
 */
export function createTerminalSurface(config: ResolvedConfig): TerminalSurface {
  const terminalTheme = createTerminalTheme(config.theme)
  const palette = terminalTheme.palette
  const terminal = new ProcessTerminal()
  const tui = config.fullscreen
    ? new TimedAltScreen(terminal, false, undefined, { mouse: true })
    : new TimedMainScreen(terminal, false)
  const header = new Text('', 0, 0)
  const headerGap = new Spacer(1)
  const composerGap = tui instanceof TuiAltScreen
    ? new ScrollToLatest(palette, () => tui.isFollowingOutput, () => { tui.scrollToBottom() })
    : new Spacer(1)
  const status = new StatusBar(() => palette.dim(' · '))
  const footer = new StatusBar(() => palette.dim(' · '))
  const waitStatus = new WaitStatusLine(palette)
  // Native padding reserves the gutter while the input surface fills the width.
  const editor = new PromptEditor(tui, editorTheme(palette), palette.autocompleteSelection, palette.dialogBand)
  editor.placeholder = 'Ask DeepSeek Harness to do anything'
  const renderer = new TranscriptRenderer({
    showReasoning: config.showReasoning,
    thinkingDisplay: config.thinkingDisplay,
    runCodeDisplay: config.runCodeDisplay,
    maxEntries: config.maxTranscriptEntries,
    palette,
    markdown: markdownTheme(palette),
  })
  // Vertical breathing room only: the transcript shares the full-width column
  // with the header, status and prompt.
  const transcript = new TranscriptBody(renderer.container)
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
  }
  else {
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
  return { terminal, tui, terminalTheme, palette, header, editor, waitStatus, status, footer, renderer, transcript }
}

/**
 * Print the Session id and the command that resumes it.
 *
 * The id comes from persisted Host state and the launcher path from the
 * environment, so both lines are sanitized before they reach the terminal.
 * @param sessionId - Session that was on screen.
 */
export async function reportExitSession(sessionId: string): Promise<void> {
  const profile = parseProfileArg(process.argv.slice(2))
  let resume = resumeHint(profile, undefined, sessionId)
  try {
    resume = resumeHint(profile, await findLauncher(profile), sessionId)
  }
  catch {
    // Keep the explicit fallback when the launcher lookup fails.
  }
  try {
    process.stdout.write(formatExitSummary(sessionId, resume))
  }
  catch {
    // A closed stdout must not turn a normal exit into a failure.
  }
}

/**
 * One teardown per application.
 *
 * Disposal can be requested by the exit shortcut, a signal, and the plugin
 * host at once; every caller must await the same run so a signal exit cannot
 * truncate cleanup another path started. Exit paths also claim the single
 * process exit, so a second signal cannot start a second teardown.
 */
export class AppShutdown {
  private disposal: Promise<void> | undefined
  private exitClaimed = false

  /** @param teardown - work that releases the terminal and the active Session. */
  constructor(private readonly teardown: (reportSession: boolean) => Promise<void>) {}

  /** Whether teardown has started; scheduling new UI work must stop once it has. */
  get disposed(): boolean {
    return this.disposal !== undefined
  }

  /** Whether a process exit has been claimed. */
  get exiting(): boolean {
    return this.exitClaimed
  }

  /**
   * Claim the one process-exit path.
   * @returns true when this caller owns the exit, false when another does.
   */
  claimExit(): boolean {
    if (this.exitClaimed || this.disposal !== undefined) return false
    this.exitClaimed = true
    return true
  }

  /**
   * Start the teardown, or join the one in flight.
   * @param reportSession - whether the summary lines should be printed.
   * @returns the shared teardown promise.
   */
  dispose(reportSession = true): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    // Defer the body one microtask so a re-entrant caller finds the promise
    // before any of the teardown runs.
    const started = Promise.resolve().then(() => this.teardown(reportSession))
    this.disposal = started
    return started
  }
}

/**
 * Exit once, after the shared teardown settles, when the process is signalled.
 *
 * Disposal may reject (the Host can fail to close a Session); leaving that
 * unhandled would report a crash on a path that is already exiting.
 * @param shutdown - the application's one teardown.
 * @param exit - process exit, injected so the handler is testable.
 * @returns the SIGTERM/SIGHUP handler.
 */
export function createSignalExit(shutdown: AppShutdown, exit: (code: number) => void): () => void {
  return () => {
    if (!shutdown.claimExit()) return
    void shutdown.dispose().catch(() => undefined).then(() => { exit(SIGNAL_EXIT_CODE) })
  }
}

/** Terminal side of the frame scheduler. */
export interface TranscriptFrameHost {
  readonly tui: { requestRender(): void; onPaint?: (durationMs: number) => void }
  readonly renderer: TranscriptRenderer
  readonly waitStatus: WaitStatusLine
  /** Terminal width; one warm frame lays the whole transcript out at it. */
  readonly columns: () => number
  /** Whether the whole terminal is disposed; nothing may schedule after it. */
  readonly disposed: () => boolean
}

/**
 * Pace transcript rebuilds and keep the wait row live.
 *
 * Rebuilds run on a cadence while streaming and once a second while waiting, so
 * a frame can land with nothing new to show. The revision comes from the
 * rebuild itself, which lets such a frame skip the repaint instead of writing an
 * identical screen. The terminal's own paint callback feeds measured cost back
 * into the interval, because the frame loop and the model-stream reader share
 * one event loop.
 */
export class TranscriptFrames {
  private timer: ReturnType<typeof setTimeout> | undefined
  private waitTicker: ReturnType<typeof setInterval> | undefined
  private readonly pacer = new StreamPacer()
  private readonly turnStatus = new TurnStatus()
  /** Bumped whenever a rebuild changes the rows the transcript paints. */
  private revision = 0
  /** What the last painted frame showed, so an identical one can be skipped. */
  private painted = { revision: -1, wait: '' }
  /** performance.now() of the last frame that actually requested a paint. */
  private lastPaintAt = 0

  /**
   * @param host - terminal surface and the one object a frame rebuilds.
   * @param renderFrame - asks the application to build and schedule a frame.
   */
  constructor(private readonly host: TranscriptFrameHost, private readonly renderFrame: () => void) {
    host.tui.onPaint = paintMs => { this.measurePaint(paintMs) }
  }

  /**
   * Build the initial transcript before the first frame paints it.
   *
   * Opening or resuming a long session otherwise creates every row on the first
   * frame, which lands exactly when output starts; warming here pays that
   * component construction once, before the terminal shows anything.
   * @param entries - durable and transient entries, oldest first.
   * @param notices - local notices placed by durable sequence.
   * @param cwd - workspace used to shorten displayed paths.
   */
  warm(entries: readonly TranscriptEntry[], notices: readonly TranscriptBlock[], cwd: string | undefined): void {
    if (entries.length === 0) return
    this.host.renderer.set(entries, notices, cwd)
    this.host.renderer.container.render(Math.max(1, this.host.columns()))
    this.pacer.prepare(0, true)
  }

  /**
   * Rebuild and paint one frame.
   * @param entries - durable and transient entries, oldest first.
   * @param notices - local notices placed by durable sequence.
   * @param cwd - workspace used to shorten displayed paths.
   * @returns entries the rebuild no longer needs; the caller may drop that prefix.
   */
  render(entries: readonly TranscriptEntry[], notices: readonly TranscriptBlock[], cwd: string | undefined): number {
    if (this.host.disposed()) return 0
    const started = performance.now()
    const { renderer, waitStatus } = this.host
    renderer.set(entries, notices, cwd)
    const pendingText = this.turnStatus.text()
    waitStatus.setText(pendingText)
    if (renderer.contentChanged) this.revision += 1
    const revision = this.revision
    const rebuildMs = performance.now() - started
    const sincePaint = performance.now() - this.lastPaintAt
    debug(`stream frame: rebuild=${rebuildMs.toFixed(1)}ms sincePaint=${sincePaint.toFixed(1)}ms interval=${String(this.pacer.interval)}ms live=${String(renderer.liveContentLength)}`)
    const mark = { revision, wait: pendingText }
    if (transcriptFrameChanged(this.painted, mark)) {
      this.painted = mark
      this.pacer.prepare(rebuildMs, renderer.coldRebuild)
      this.lastPaintAt = performance.now()
      this.host.tui.requestRender()
    }
    return renderer.retainedFrom
  }

  /**
   * Ask for a frame.
   * @param immediate - paint now instead of waiting for the next stream frame.
   *   Bursts are still coalesced so one interval never paints twice.
   */
  schedule(immediate = false): void {
    if (this.host.disposed()) return
    const elapsed = performance.now() - this.lastPaintAt
    if (immediate && elapsed >= this.pacer.interval) {
      this.cancelTimer()
      this.renderFrame()
      return
    }
    if (this.timer !== undefined) return
    const delay = nextFrameDelay(this.pacer.interval, elapsed)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.renderFrame()
    }, delay)
  }

  /** Show working status and start the one-second repaint of its elapsed time. */
  beginWait(retry?: WaitRetry): void {
    this.turnStatus.begin(retry)
    if (this.waitTicker === undefined) this.waitTicker = setInterval(() => { this.schedule(true) }, WAIT_ROW_TICK_MS)
    this.schedule(true)
  }

  /** Keep the live status but clear a retry label the Host has moved past. */
  resumeWait(): void {
    this.turnStatus.resume()
  }

  /** Settle the live status into a receipt and stop its ticker. */
  finishWait(reason: TurnEndReason): void {
    this.turnStatus.finish(reason)
    this.stopWaitTicker()
  }

  /** Stop every timer this scheduler owns and clear live status. */
  clear(): void {
    this.cancelTimer()
    this.stopWaitTicker()
    this.turnStatus.clear()
  }

  /** Reset pacing after a session, density or palette change. */
  reset(): void {
    this.pacer.reset()
  }

  private measurePaint(paintMs: number): void {
    const cost = this.pacer.paint(paintMs)
    if (cost === undefined) return
    debug(`stream paint: paint=${paintMs.toFixed(1)}ms cost=${cost.toFixed(1)}ms interval=${String(this.pacer.interval)}ms live=${String(this.host.renderer.liveContentLength)}`)
    if (this.timer !== undefined) {
      this.cancelTimer()
      this.schedule()
    }
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private stopWaitTicker(): void {
    if (this.waitTicker === undefined) return
    clearInterval(this.waitTicker)
    this.waitTicker = undefined
  }
}
