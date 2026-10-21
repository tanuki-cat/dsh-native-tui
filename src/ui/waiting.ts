/** Execution and retry reporting in a fixed-height chrome row. */
import { Container, TruncatedText } from '@earendil-works/pi-tui'
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
    const label = text === '' ? '' : this.palette.accent('⟳ ') + this.palette.dim(text)
    this.children = [new TruncatedText(label)]
  }
}

export const WAIT_ROW_TICK_MS = 1000

/** Host-reported automatic retry; independent of transcript rendering. */
export interface WaitRetry {
  readonly retry: number
  readonly maxRetries: number
  readonly code: string
}

/** Describe execution until the turn ends, including while content or tools are streaming. */
export function waitingText(since: number, retry: WaitRetry | undefined, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const state = retry === undefined
    ? 'working'
    : 'retry ' + String(retry.retry) + '/' + String(retry.maxRetries) + ' after ' + retry.code + ' (automatic)'
  return state + ' · ' + String(seconds) + 's'
}
