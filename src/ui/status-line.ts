/**
 * The header and status rows the terminal repaints on every event.
 *
 * Extracted from `app.ts` so the paint logic is readable on its own and the
 * application file stays a wiring layer.
 *
 * @module dsh-native-tui/ui/status-line
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresetService } from '../runtime/agent.js'
import type { SessionStats } from '../runtime/metrics.js'
import { collectSessionMetrics, formatSessionMetrics } from '../runtime/metrics.js'
import type { Palette } from './theme.js'

/** The pi-tui text components the status rows write into. */
export interface StatusRows {
  readonly header: { setText(text: string): void }
  readonly status: { setText(text: string): void }
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
  readonly stats: SessionStats | undefined
  readonly events: readonly unknown[]
}

/**
 * Repaint the header and status rows.
 * @param rows - the text components to update.
 * @param palette - colours.
 * @param input - the current session state.
 */
export function renderStatusRows(rows: StatusRows, palette: Palette, input: StatusInput): void {
  rows.header.setText(
    palette.bold(palette.brand('◆ ' + input.title)) + '  ' + palette.dim(input.sessionId) + '\n'
    + palette.dim(input.cwd),
  )
  const state = input.running
    ? palette.warning('● working')
    : palette.success('● idle')
  const metaBits: string[] = []
  if (input.preset !== undefined) metaBits.push(palette.dim('preset ' + input.preset))
  if (input.reasoningEffort !== undefined) metaBits.push(palette.dim('effort ' + String(input.reasoningEffort)))
  if (input.attachmentCount > 0) metaBits.push(palette.dim('attached ' + String(input.attachmentCount)))
  const hint = input.running
    ? 'enter steer · esc cancel · ctrl+c cancel · ctrl+d exit'
    : 'enter send · /help · ctrl+d exit'
  const metrics = collectSessionMetrics(input.events as never, input.stats, input.contextWindow)
  const modelLine = state + '  ' + palette.bold(palette.accent('model ' + input.provider + '/' + input.model))
  const metaLine = [...metaBits, palette.dim(hint)].join('   ')
  rows.status.setText(modelLine + '\n' + metaLine + '\n'
    + palette.dim('↳ ' + formatSessionMetrics(metrics)))
}

/** Read the session's preset through the host registry. */
export function currentPreset(presets: AgentPresetService | undefined, ctx: Context): string | undefined {
  return presets?.composedPreset(ctx)
}
