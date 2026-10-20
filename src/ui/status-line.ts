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
import type { ContextMeterReading, SessionStats } from '../runtime/metrics.js'
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

/** Split the compact metrics row into usage and context lines. */
export function splitSessionMetrics(text: string): { readonly usage: string; readonly context: string | undefined } {
  const parts = text.split('  ·  ')
  const context = parts.at(-1)
  if (context !== undefined && context.startsWith('ctx ')) {
    return { usage: parts.slice(0, -1).join('  ·  '), context }
  }
  return { usage: text, context: undefined }
}

/**
 * Repaint the header, status block, and footer.
 * @param rows - the text components to update.
 * @param palette - colours.
 * @param input - the current session state.
 */
export function renderStatusRows(rows: StatusRows, palette: Palette, input: StatusInput): void {
  rows.header.setText(
    palette.bold(palette.brand('◆ ' + input.title)) + '\n'
    + palette.dim(input.sessionId) + '\n'
    + palette.dim(input.cwd),
  )
  const state = input.running
    ? palette.warning('● working')
    : palette.success('● idle')
  const thinking = input.reasoningEffort === undefined
    ? palette.dim('think default')
    : palette.dim('think ' + String(input.reasoningEffort))
  const metaBits: string[] = []
  if (input.preset !== undefined) metaBits.push(palette.dim('preset ' + input.preset))
  if (input.attachmentCount > 0) metaBits.push(palette.dim('attached ' + String(input.attachmentCount)))
  const hint = input.running
    ? 'enter steer · esc cancel · ctrl+c cancel · ctrl+d exit'
    : 'enter send · /help · ctrl+d exit'
  metaBits.push(palette.dim(hint))
  const metrics = collectSessionMetrics(input.events as never, input.stats, input.contextWindow, input.contextMeter)
  const split = splitSessionMetrics(formatSessionMetrics(metrics))
  rows.status.setText(
    state + '   ' + palette.bold(palette.accent('model ' + input.provider + '/' + input.model))
    + '   ' + thinking + '\n\n' + metaBits.join('   '),
  )
  rows.footer.setText(
    palette.dim('↳ ' + split.usage)
    + (split.context === undefined ? '' : '\n' + palette.dim('  ' + split.context)),
  )
}

/** Read the session's preset through the host registry. */
export function currentPreset(presets: AgentPresetService | undefined, ctx: Context): string | undefined {
  return presets?.composedPreset(ctx)
}
