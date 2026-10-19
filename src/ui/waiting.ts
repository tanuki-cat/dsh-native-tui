/**
 * The transient model-wait row helpers.
 *
 * @module dsh-native-tui/ui/waiting
 */

/**
 * How long a request may be in flight before the wait row is worth showing.
 * Below it the row would only flash between two frames of a fast model, and
 * the application repaints on this same cadence to make the row appear on time.
 */
export const WAIT_ROW_DELAY_MS = 1000

/** How one model wait is going, for {@link waitingText}. */
export interface WaitRetry {
  /** 1-based retry number the provider is on. */
  readonly retry: number
  /** Retries the policy allows; 0 when the host stated none. */
  readonly maxRetries: number
  /** Harness failure code that triggered the retry. */
  readonly code: string
}

/**
 * Whether one in-flight wait is worth reporting. A scheduled retry is always
 * worth reporting: the reader already sat through the failed attempt, and the
 * row is what tells them the replay is automatic.
 * @param since - epoch ms the wait began.
 * @param retry - retry state, when this wait follows a failed attempt.
 * @param now - current epoch ms.
 * @returns true when the row should be rendered.
 */
export function waitingVisible(since: number, retry: WaitRetry | undefined, now: number): boolean {
  return retry !== undefined || now - since >= WAIT_ROW_DELAY_MS
}

/**
 * Describe one in-flight model wait; {@link waitingVisible} decides whether it
 * is due to be shown at all. The elapsed seconds are the reader's liveness
 * signal for deciding whether to keep waiting or retry by hand, so they keep
 * ticking until the first frame arrives.
 * @param since - epoch ms the wait began.
 * @param retry - retry state, when this wait follows a failed attempt.
 * @param now - current epoch ms.
 * @returns the one-line row text.
 */
export function waitingText(since: number, retry: WaitRetry | undefined, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const suffix = retry === undefined
    ? ''
    : '  ·  retry ' + String(retry.retry) + '/' + String(retry.maxRetries) + ' after ' + retry.code + ' (automatic)'
  return 'waiting for API response · ' + String(seconds) + 's' + suffix
}
