/**
 * The header, live status block, and footer the terminal repaints on every event.
 *
 * Extracted from `app.ts` so the paint logic is readable on its own and the
 * application file stays a wiring layer.
 *
 * @module dsh-native-tui/ui/status-line
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresetService } from '../runtime/agent.js'
import type { ContextMeterReading, SessionMetrics, SessionStats } from '../runtime/metrics.js'
import { collectSessionMetrics, formatSessionMetrics } from '../runtime/metrics.js'
import type { Palette } from './theme.js'

/** The pi-tui text components the status rows write into. */
export interface StatusRows {
  readonly header: { setText(text: string): void }
  readonly status: { setText(text: string): void }
  readonly footer: { setText(text: string): void }
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
  rows.header.setText(
    palette.bold(palette.brand('◆ ' + input.title)) + '\n'
    + palette.dim(input.sessionId) + '\n'
    + palette.dim(input.cwd),
  )
  const state = input.running
    ? palette.warning('● working')
    : palette.success('● idle')
  const thinking = palette.reasoning(input.reasoningEffort)(
    input.reasoningEffort === undefined ? 'think default' : 'think ' + String(input.reasoningEffort),
  )
  const metaBits: string[] = []
  if (input.preset !== undefined) metaBits.push(palette.dim('preset ') + palette.preset(input.preset))
  if (input.attachmentCount > 0) metaBits.push(palette.dim('attached ') + palette.accent(String(input.attachmentCount)))
  const hint = input.running
    ? 'enter steer · esc cancel · ctrl+c cancel · ctrl+d exit'
    : 'enter send · /help · ctrl+d exit'
  metaBits.push(palette.dim(hint))
  const metrics = fold === undefined
    ? collectSessionMetrics(input.events as never, input.stats, input.contextWindow, input.contextMeter)
    : fold(input.events as never, input.stats, input.contextWindow, input.contextMeter)
  const split = splitSessionMetrics(formatSessionMetrics(metrics))
  const model = palette.dim('model ')
    + palette.bold(palette.brand(input.provider))
    + palette.dim('/')
    + palette.bold(palette.accent(input.model))
  const context = split.context === undefined ? undefined : splitContextLine(split.context)
  rows.status.setText(
    state + '   ' + model + '   ' + thinking + '\n\n' + metaBits.join('   '),
  )
  rows.footer.setText(
    palette.accent('↳ ') + palette.dim(split.usage)
    + (context === undefined
      ? ''
      : '\n  ' + palette.context(metrics.contextPercent, metrics.contextCompactPercent)(context.head)
        + (context.detail === '' ? '' : palette.dim(context.detail))),
  )
}

/** Read the session's preset through the host registry. */
export function currentPreset(presets: AgentPresetService | undefined, ctx: Context): string | undefined {
  return presets?.composedPreset(ctx)
}
