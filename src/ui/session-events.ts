/**
 * The Host event subscriptions that keep the transcript live.
 *
 * The application owns the mutable transcript arrays; this module owns the
 * decision of which event becomes which transcript entry, so the wiring in
 * `app.ts` stays a list of subscriptions.
 *
 * @module dsh-native-tui/ui/session-events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChangesSummaryView } from '../runtime/changes.js'
import { formatChangesSummary } from '../runtime/changes.js'
import { formatDeliverables, type PresentedFileView } from '../runtime/deliverables.js'
import type { TranscriptEntry } from './transcript.js'
import type { WaitRetry } from './waiting.js'

/** The workspace-changes service slice the live listener reads. */
interface ChangesService {
  summary(sessionId: SessionId, seq: number): ChangesSummaryView | undefined
}

/** What the live listeners write into. */
export interface SessionEventsHost {
  /** Host context, for the service lookups and the event bus. */
  readonly host: Context
  /** The session currently on screen. */
  readonly sessionId: () => SessionId
  /** Append one transcript entry. */
  readonly appendEntry: (entry: TranscriptEntry) => void
  /** Replace the entry list, used to drop a live entry superseded by the durable one. */
  readonly replaceEntries: (update: (entries: readonly TranscriptEntry[]) => TranscriptEntry[]) => void
  /** Notice for a change summary or a presented deliverable. */
  readonly notice: (text: string) => void
  /** Re-render the transcript soon. */
  readonly scheduleTranscript: () => void
  /** Re-render the status row now. */
  readonly renderStatus: () => void
  /** Record a live attempt's turn/step so its chunks are attributed correctly. */
  readonly beginAttempt: (attemptId: string, turn: number, step: number) => void
  /** Forget a finished attempt. */
  readonly endAttempt: (attemptId: string) => void
  /** Allocate the next live chunk sequence number. */
  readonly nextLiveSeq: () => number
  /** The turn/step recorded for one attempt, when it is known. */
  readonly attemptPosition: (attemptId: string) => { turn: number; step: number } | undefined
  /** A model request started; nothing has streamed from it yet. */
  readonly beginWait: () => void
  /** A failed attempt scheduled a retry, which is now the reason for waiting. */
  readonly retryScheduled: (retry: WaitRetry) => void
  /** The turn settled, so no request is in flight any more. */
  readonly endWait: () => void
}

/** Subscribe the transcript to one session's events. */
export function subscribeSessionEvents(host: SessionEventsHost): () => void {
  const timers: Array<() => void> = []
  const own = (dispose: () => void): void => { timers.push(dispose) }

  own(host.host.on('session/event', (session, event) => {
    if (session.id !== host.sessionId()) return
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      // Either settlement ends the step's transient rows. An attempt's own live
      // chunks all precede it, so a retry that follows keeps its own chunks.
      const turn = event.data.turn
      const step = event.data.step
      host.replaceEntries(entries => entries.filter(entry => !(
        entry.type === 'live'
        && entry.event.data.turn === turn
        && entry.event.data.step === step
      )))
    }
    host.appendEntry({ type: 'event', event })
    if ((event.type as string) === 'workspace/changes') {
      const changes = host.host.get('workspaceChanges') as ChangesService | undefined
      const summary = changes?.summary(session.id, Number(event.seq))
      if (summary !== undefined) host.notice(formatChangesSummary(summary))
    }
    if ((event.type as string) === 'deliverables/presented') {
      const data = event.data as { readonly turn: number; readonly files: readonly PresentedFileView[] }
      host.notice(formatDeliverables([{ turn: data.turn, files: data.files }]))
    }
    if ((event.type as string) === 'llm/retry') {
      const data = event.data as {
        readonly retry?: unknown
        readonly maxRetries?: unknown
        readonly failure?: { readonly code?: unknown }
      }
      host.retryScheduled({
        retry: typeof data.retry === 'number' ? data.retry : 0,
        maxRetries: typeof data.maxRetries === 'number' ? data.maxRetries : 0,
        code: typeof data.failure?.code === 'string' ? data.failure.code : 'ERROR',
      })
    }
    if (event.type === 'turn/end' || event.type === 'assistant/message' || event.type === 'tool/call') host.endWait()
    host.scheduleTranscript()
    host.renderStatus()
  }))

  own(host.host.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id !== host.sessionId()) return
    if (frame.type === 'start') {
      host.beginAttempt(String(frame.attemptId), frame.turn, frame.step)
      host.beginWait()
      return
    }
    if (frame.type === 'end') {
      host.endAttempt(String(frame.attemptId))
      return
    }
    const position = host.attemptPosition(String(frame.attemptId)) ?? { turn: 0, step: 0 }
    host.appendEntry({
      type: 'live',
      event: {
        type: 'assistant/live-chunk',
        seq: host.nextLiveSeq(),
        time: frame.time,
        data: {
          attemptId: String(frame.attemptId),
          turn: position.turn,
          step: position.step,
          chunk: frame.chunk,
        },
      },
    })
    host.scheduleTranscript()
  }))

  own(host.host.on('agent/status', ({ agent }) => {
    if (agent.id === host.sessionId()) host.renderStatus()
  }))

  return () => {
    for (const dispose of timers) dispose()
  }
}
