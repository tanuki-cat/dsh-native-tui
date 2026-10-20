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
 * What the model has produced during the current wait. Text and thinking clear
 * the row as soon as they are visible, so only two states are observable: the
 * request has said nothing yet, or it is filling in a tool call. The second one
 * is why the row cannot call itself an API wait: a model writing a `run_code`
 * program streams for a long time without any answer text.
 */
export type WaitSubject =
  /** Nothing readable has arrived: the request itself is what is pending. */
  | { readonly kind: 'request' }
  /** A tool call is streaming; the name arrives with its first delta. */
  | { readonly kind: 'tool'; readonly name?: string }

/** The slice of a stream chunk {@link waitSubjectAfter} reads. */
export interface WaitChunk {
  readonly type: string
  readonly name?: string
}

/**
 * Fold one stream chunk into the wait subject. Only the tool-call channel moves
 * it: a bare `block-start` keeps the previous subject, and the deltas after the
 * first one only extend the arguments, so the known name is never dropped.
 * @param subject - the subject before this chunk.
 * @param chunk - one live assistant stream chunk.
 * @returns the subject to report from now on.
 */
export function waitSubjectAfter(subject: WaitSubject, chunk: WaitChunk): WaitSubject {
  if (chunk.type !== 'tool-call-delta') return subject
  if (chunk.name !== undefined) return { kind: 'tool', name: chunk.name }
  return subject.kind === 'tool' ? subject : { kind: 'tool' }
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
 * ticking until the first readable frame arrives. The verb follows
 * {@link WaitSubject}, so the row names what is actually pending.
 * @param since - epoch ms the wait began.
 * @param retry - retry state, when this wait follows a failed attempt.
 * @param now - current epoch ms.
 * @param subject - what the model has produced so far this wait.
 * @returns the one-line row text.
 */
export function waitingText(
  since: number,
  retry: WaitRetry | undefined,
  now: number,
  subject: WaitSubject = { kind: 'request' },
): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const suffix = retry === undefined
    ? ''
    : '  ·  retry ' + String(retry.retry) + '/' + String(retry.maxRetries) + ' after ' + retry.code + ' (automatic)'
  return waitingVerb(subject) + ' · ' + String(seconds) + 's' + suffix
}

/** The verb phrase for one subject, without the elapsed time or retry suffix. */
function waitingVerb(subject: WaitSubject): string {
  if (subject.kind !== 'tool') return 'waiting for response'
  return subject.name === undefined ? 'generating a tool call' : 'generating ' + subject.name + ' call'
}
