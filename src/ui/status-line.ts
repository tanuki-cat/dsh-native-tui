/**
 * The header, live status block, and footer the terminal repaints on every event.
 *
 * Extracted from `app.ts` so the paint logic is readable on its own and the
 * application file stays a wiring layer.
 *
 * @module dsh-native-tui/ui/status-line
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import type { AgentPresetService } from '../runtime/agent.js'
import type { ContextMeterReading, SessionMetrics, SessionStats } from '../runtime/metrics.js'
import { collectSessionMetrics, formatSessionMetrics } from '../runtime/metrics.js'
import type { Palette } from './theme.js'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { MODE_LABELS, type InteractionMode } from '../interaction-modes.js'
import type { StatusBarTarget, StatusSegment } from './status-bar.js'

/** The pi-tui text components the status rows write into. */
export interface StatusRows {
  readonly header: { setText(text: string): void }
  readonly status: StatusBarTarget
  readonly footer: StatusBarTarget
}

/** Live state one repaint reads. */
export interface StatusInput {
  readonly title: string
  readonly sessionId: string
  readonly cwd: string
  readonly running: boolean
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | undefined
  readonly interactionMode?: InteractionMode | 'custom'
  readonly permissionPreset?: string
  readonly preset: string | undefined
  readonly attachmentCount: number
  readonly contextWindow: number | undefined
  /**
   * Token meter reading when that service is mounted; absent in compositions
   * without it, where the durable log's last prompt stands in.
   */
  readonly contextMeter: ContextMeterReading | undefined
  readonly stats: SessionStats | undefined
  readonly events: readonly unknown[]
}

/** Split one context line into the colored head and its dim detail. */
export function splitContextLine(context: string): { readonly head: string; readonly detail: string } {
  const index = context.indexOf('  ')
  if (index === -1) return { head: context, detail: '' }
  return { head: context.slice(0, index), detail: context.slice(index) }
}

/** Split the compact metrics row into usage and context lines. */
export function splitSessionMetrics(text: string): { readonly usage: string; readonly context: string | undefined } {
  const parts = text.split('  ·  ')
  const context = parts.at(-1)
  if (context !== undefined && context.startsWith('ctx ')) {
    return { usage: parts.slice(0, -1).join('  ·  '), context }
  }
  return { usage: text, context: undefined }
}

/** One accent per usage category, mirroring Codex's per-field status-line accents. */
function metricAccent(text: string, palette: Palette): (text: string) => string {
  if (text.endsWith(' tok/s')) return palette.success
  if (text.endsWith(' tok')) return palette.model
  if (text.startsWith('cache ')) return palette.preset
  return palette.accent
}

/** Fold the status-bar metrics from one repaint's inputs. */
export type MetricsFold = (
  events: readonly never[],
  stats: SessionStats | undefined,
  contextWindow: number | undefined,
  meter: ContextMeterReading | undefined,
) => SessionMetrics

/**
 * Repaint the header, status block, and footer.
 *
 * The fold runs on every Session event, so callers that repaint often pass a
 * memoizing one; the plain fold is the default for one-shot renderers.
 * @param rows - the text components to update.
 * @param palette - colours.
 * @param input - the current session state.
 * @param fold - metric fold, normally a memo over the whole event log.
 */
export function renderStatusRows(
  rows: StatusRows,
  palette: Palette,
  input: StatusInput,
  fold?: MetricsFold,
): void {
  const label = (value: string): string => sanitizeTerminalText(value).replace(/[\n\t]/gu, ' ').trim()
  rows.header.setText(
    palette.bold(label(input.title)) + '\n'
    + palette.dim(label(input.sessionId)),
  )
  const state = input.running
    ? palette.warning('Working')
    : palette.ready('Ready')
  const thinking = input.reasoningEffort === undefined ? ''
    : ' ' + label(String(input.reasoningEffort))
  const metrics = fold === undefined
    ? collectSessionMetrics(input.events as never, input.stats, input.contextWindow, input.contextMeter)
    : fold(input.events as never, input.stats, input.contextWindow, input.contextMeter)
  const split = splitSessionMetrics(formatSessionMetrics(metrics))
  const model = palette.bold(palette.model(label(input.model) + thinking))
  const cwd = workspacePath(label(input.cwd))
  const status: StatusSegment[] = [{
    text: palette.dim(label(input.provider))
    + palette.dim('/')
    + model,
    compact: model,
  }, {
    text: palette.workspace(cwd),
    compact: palette.workspace(cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd),
    priority: 2,
  }, { text: state }]
  const percent = metrics.contextPercent
  const context = palette.context(percent, metrics.contextCompactPercent)
  status.push({
    text: context(percent === undefined ? 'Context —' : 'Context ' + String(percent) + '% used'),
    compact: context(percent === undefined ? 'ctx —' : 'ctx ' + String(percent) + '%'),
  })
  if (input.attachmentCount > 0) status.push({ text: palette.accent('attached ' + String(input.attachmentCount)) })
  if (input.preset !== undefined) status.push({ text: palette.dim('preset ') + palette.preset(label(input.preset)), priority: 3 })
  status.push(...split.usage.split('  ·  ').flatMap((text, index) => text.startsWith('0 ') || text.includes('—') ? [] : [{
    text: metricAccent(text, palette)(text), priority: index < 2 ? 6 : index === 2 ? 4 : 5,
  }]))
  rows.status.setSegments(status)
  const mode = input.interactionMode
  const footer: StatusSegment[] = []
  if (mode !== undefined) footer.push({ text: (mode === 'custom'
    ? palette.warning('custom mode')
    : (mode === 'off' ? palette.dim : mode === 'accept-edits' ? palette.success : palette.warning)(MODE_LABELS[mode] + (mode === 'auto' ? ' · EXP' : ''))) })
  if ((mode === 'off' || mode === undefined) && input.permissionPreset !== undefined) {
    const permission = (input.permissionPreset === 'danger-full-access' ? palette.warning : palette.accent)(label(input.permissionPreset))
    footer.push({ text: palette.dim('permission ') + permission, compact: permission })
  }
  const hints = input.running
    ? ['enter steer', 'esc cancel', 'ctrl+c cancel', 'ctrl+d exit']
    : ['enter send', 'shift+tab think', '/help', 'ctrl+d exit']
  footer.push(...hints.map((text, index) => ({ text: palette.dim(text), priority: index + 1 })))
  rows.footer.setSegments(footer)
}

/** Replace the home directory only at a path boundary. */
export function workspacePath(cwd: string, home = homedir()): string {
  if (cwd === home) return '~'
  return cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd
}

/** Longest workspace label woven into the terminal window title. */
const WINDOW_TITLE_WORKSPACE_CHARS = 48

/**
 * Terminal window title naming the workspace this session edits.
 *
 * A terminal tab otherwise shows only the launcher name, so several sessions
 * opened from different checkouts are indistinguishable in the tab strip. The
 * label pairs the product with the working directory's last segment, mirroring
 * how pi titles its tabs (`π − <workspace>`).
 * @param title - configured product title.
 * @param cwd - workspace directory the session runs in.
 * @returns one single-line title, safe for an OSC 0 sequence.
 */
export function terminalWindowTitle(title: string, cwd: string): string {
  // OSC 0 is terminated by BEL, so control characters would truncate the title
  // or inject a second sequence; the label is flattened to visible text.
  const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim()
  const product = clean(title)
  const workspace = clean(cwd).replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? ''
  const label = workspace.length <= WINDOW_TITLE_WORKSPACE_CHARS
    ? workspace
    : workspace.slice(0, WINDOW_TITLE_WORKSPACE_CHARS - 1) + '…'
  if (label === '') return product
  return product === '' ? label : product + ' · ' + label
}

/** Read the session's preset through the host registry. */
export function currentPreset(presets: AgentPresetService | undefined, ctx: Context): string | undefined {
  return presets?.composedPreset(ctx)
}
