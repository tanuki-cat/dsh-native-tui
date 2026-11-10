/**
 * Shared surface the command handlers run against.
 *
 * `app.ts` owns the terminal, the active session and the transcript state; the
 * handlers in `src/ui/commands/` own the semantics of one command family each,
 * and `router.ts` dispatches a submitted line onto them. This file is the
 * contract between them: a handler receives one context and calls back through
 * it, so a split moves code without changing behaviour.
 *
 * @module dsh-native-tui/ui/commands/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../../config.js'
import type { HostSession } from '../../runtime/agent.js'
import type { PendingAttachment } from '../../runtime/attachments.js'
import type { ContextBreakdown, SessionMetrics } from '../../runtime/metrics.js'
import type { Palette } from '../theme.js'
import type { ContextReportData } from '../context-report.js'
import type { LLM } from './services.js'
import type { ModelSelectionState } from '../../runtime/model-selection.js'

/** One notice line in the transcript. */
export type NoticeTone = 'info' | 'warning' | 'error'

export type { ModelSelectionState } from '../../runtime/model-selection.js'

/** Staged attachments, mutated in place so the app keeps one array. */
export interface AttachmentState {
  /** The live staged list. Handlers push, splice, or replace its contents. */
  readonly pending: PendingAttachment[]
  /** Replace the list contents (`/attach clear`). */
  clear(): void
}

/** Everything a command handler needs from the terminal application. */
export interface CommandContext {
  /** Host plugin context. */
  readonly host: Context
  /** Resolved terminal configuration. */
  readonly config: ResolvedConfig
  /** Palette the handler renders with. */
  readonly palette: Palette
  /** The pi-tui instance the handler puts overlays on. */
  readonly tui: CommandSurface
  /** The session currently on screen. */
  readonly active: HostSession
  /** Dispose the expected idle Agent and restore its Session; rejects a stale selection or failed restart. */
  readonly restartSession?: (expected: HostSession) => Promise<HostSession>
  /** Cancellation for the whole command run. */
  readonly signal: AbortSignal
  /** False after the owning Session is replaced or the terminal starts closing. */
  readonly isCurrent?: () => boolean
  /** Render a notice, optionally carrying structured context-report figures. */
  readonly notice: (tone: NoticeTone, text: string, contextReport?: ContextReportData) => void
  /** Redraw the header and status row. */
  readonly renderStatus: () => void
  /** Staged attachments. */
  readonly attachments: AttachmentState
  /** Route another command line through the same dispatcher. */
  readonly runCommand: (line: string) => Promise<void>
  /** Open the terminal-level settings editor. */
  readonly openTuiSettings: () => Promise<void>
  /** Print the host settings summary. */
  readonly showHostSettings: () => void
  /** The writable model selection for the current session. */
  readonly modelSelection: ModelSelectionState
  /** Set the context window the status row reports, or clear it. */
  /**
   * Record the routed model's context capacity and the output it reserves, so
   * the status row can price context against the compaction threshold.
   */
  readonly setContextWindow: (tokens: number | undefined, reservedTokens?: number) => void
  /**
   * The session's context figures, read from the same meter inputs the status
   * row prices: its folded metrics and the meter's heuristic composition
   * (undefined when that projection is not mounted).
   */
  readonly readContext: () => { readonly metrics: SessionMetrics; readonly breakdown: ContextBreakdown | undefined }
  /**
   * Put an invocation of a user-invocable skill into the prompt editor.
   *
   * The editor stages `/skill:<name>`, which the router turns into the Host's
   * `/<name>` prompt gesture. Staging rather than sending keeps the draft
   * under the user's control: they add their own instructions and submit once, so
   * `/skill` never fires a request on their behalf.
   */
  readonly stageSkillInvocation: (name: string) => void
  /** Persist the current model selection for future sessions. */
  readonly persistSelection: (selection: NonNullable<ModelSelectionState['current']>) => Promise<void>
}

/** The overlay surface a handler renders into: the pi-tui instance. */
export type CommandSurface = import('@earendil-works/pi-tui').TUI

/** The LLM catalogue, re-exported so handlers import one place. */
export type { LLM }
