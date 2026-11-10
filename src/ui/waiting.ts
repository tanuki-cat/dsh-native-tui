/** Execution and retry reporting in a fixed-height chrome row. */
import { Container, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { formatLocalTimestamp } from './format-time.js'
import type { Palette } from './theme.js'

/** A single chrome row, including while idle, so state transitions cannot shift the prompt. */
export class WaitStatusLine extends Container {
  private text: string | undefined

  constructor(private readonly palette: Palette) {
    super()
    this.setText('')
  }

  setText(text: string): void {
    if (text === this.text) return
    this.text = text
    this.children = [{
      render: width => {
        const row = truncateToWidth(styleTurnStatus(text, this.palette), width, '…')
        return [this.palette.plain ? stripTerminalSequences(row) : row]
      },
      invalidate: () => {},
    }]
  }
}

export const WAIT_ROW_TICK_MS = 1000

/** Host-reported automatic retry; independent of transcript rendering. */
export interface WaitRetry {
  readonly retry: number
  readonly maxRetries: number
  readonly code: string
}

/** Shared live-operation heading for turn chrome and transcript progress. */
export function activityHeading(label: string, palette: Palette, detail = '', warning = false): string {
  const clean = (text: string): string => sanitizeTerminalText(text).replace(/[\r\n\t]/gu, ' ')
  return palette.dim('• ') + (warning ? palette.warning : palette.bold)(clean(label)) + palette.dim(clean(detail))
}

/** A quiet live heading or a settled receipt, styled at paint time for terminal theme changes. */
export function styleTurnStatus(raw: string, palette: Palette): string {
  const text = sanitizeTerminalText(raw).replace(/[\r\n\t]/gu, ' ')
  const boundary = text.indexOf(' (')
  if ((text.startsWith('Working (') || text.startsWith('Retrying ')) && boundary !== -1) {
    const header = text.slice(0, boundary)
    return activityHeading(header, palette, text.slice(boundary), text.startsWith('Retrying '))
  }
  const color = text.startsWith('Failed ') ? palette.error
    : /^(?:Cancelled|Interrupted|Blocked|Stopped|Forked) /u.test(text) ? palette.warning : undefined
  const firstSpace = text.indexOf(' ')
  return color === undefined || firstSpace < 0 ? palette.dim(text)
    : color(text.slice(0, firstSpace)) + palette.dim(text.slice(firstSpace))
}

/** Preserve the shared second rounding and unpadded hour/minute/second units. */
export function formatElapsedDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return (seconds >= 3600 ? String(Math.floor(seconds / 3600)) + 'h ' : '')
    + (seconds >= 60 ? String(Math.floor(seconds / 60) % 60) + 'm ' : '')
    + String(seconds % 60) + 's'
}

/** Describe execution until the turn ends, including while content or tools are streaming. */
export function waitingText(since: number, retry: WaitRetry | undefined, now: number): string {
  const elapsed = formatElapsedDuration(now - since)
  return retry === undefined ? 'Working (' + elapsed + ' · esc to interrupt)'
    : 'Retrying ' + retry.retry + '/' + retry.maxRetries + ' (' + elapsed + ' · ' + retry.code + ' · automatic · esc to interrupt)'
}

/** The current live turn and its last receipt; reset on session switch, never persisted as history. */
export class TurnStatus {
  private since: number | undefined
  private retry: WaitRetry | undefined
  private receipt = ''

  begin(retry?: WaitRetry, now = Date.now()): void {
    this.since ??= now
    this.retry = retry
    this.receipt = ''
  }

  resume(): void { this.retry = undefined }

  finish(reason: TurnEndReason, now = Date.now(), timeZone?: string): void {
    if (this.since === undefined) return
    const kind = reason.kind
    const state = kind === 'completed' ? 'Worked for' : kind === 'error' ? 'Failed after'
      : kind === 'aborted' ? 'Cancelled after' : kind === 'blocked' ? 'Blocked after'
        : kind === 'interrupted' ? 'Interrupted after' : kind === 'forked' ? 'Forked after'
          : kind === 'max-tokens' ? 'Stopped at token limit after' : 'Stopped after'
    this.receipt = state + ' ' + formatElapsedDuration(now - this.since) + ' · ' + formatLocalTimestamp(now, timeZone).slice(11, 16)
    this.since = undefined
    this.retry = undefined
  }

  clear(): void { this.since = undefined; this.retry = undefined; this.receipt = '' }

  text(now = Date.now()): string { return this.since === undefined ? this.receipt : waitingText(this.since, this.retry, now) }
}
