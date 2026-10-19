import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { subscribeSessionEvents, type SessionEventsHost } from '../src/ui/session-events.js'
import type { TranscriptEntry, WaitRetry } from '../src/ui/transcript.js'

/** What one subscribed app observed, in call order. */
interface Recorded {
  readonly begins: number
  readonly retries: WaitRetry[]
  readonly ends: number
  readonly entries: TranscriptEntry[]
  readonly notices: string[]
}

/** Wire the subscriber to a recording stub bus. */
function harness(): { emit: (name: string, ...args: unknown[]) => void; seen: Recorded } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const seen = { begins: 0, retries: [] as WaitRetry[], ends: 0, entries: [] as TranscriptEntry[], notices: [] as string[] }
  const host: SessionEventsHost = {
    host: {
      on: (name: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => { handlers.set(name, list.filter(entry => entry !== handler)) }
      },
      get: () => undefined,
    } as unknown as Context,
    sessionId: () => 's1' as never,
    appendEntry: entry => { seen.entries.push(entry) },
    replaceEntries: update => { seen.entries.splice(0, seen.entries.length, ...update(seen.entries)) },
    notice: text => { seen.notices.push(text) },
    scheduleTranscript: () => {},
    renderStatus: () => {},
    beginAttempt: () => {},
    endAttempt: () => {},
    nextLiveSeq: () => 1,
    attemptPosition: () => undefined,
    beginWait: () => { seen.begins += 1 },
    retryScheduled: retry => { seen.retries.push(retry) },
    endWait: () => { seen.ends += 1 },
  }
  subscribeSessionEvents(host)
  return {
    seen,
    emit: (name, ...args) => { for (const handler of handlers.get(name) ?? []) handler(...args) },
  }
}

describe('session event wait reporting', () => {
  it('reports a model wait from the attempt start frame', () => {
    const { emit, seen } = harness()
    emit('agent/assistant-stream', { agent: { id: 's1' }, frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } })
    expect(seen.begins).toBe(1)
    expect(seen.entries).toHaveLength(0)
  })

  it('reports the retry policy that took over from the failed attempt', () => {
    const { emit, seen } = harness()
    emit('session/event', { id: 's1' }, {
      type: 'llm/retry',
      seq: 7,
      data: { retry: 2, maxRetries: 5, failure: { code: 'TRANSPORT' } },
    })
    expect(seen.retries).toEqual([{ retry: 2, maxRetries: 5, code: 'TRANSPORT' }])
    // The durable event still reaches the transcript, not just the wait row.
    expect(seen.entries.map(entry => entry.type === 'event' ? entry.event.type : entry.type)).toEqual(['llm/retry'])
  })

  it('falls back to an unnamed retry when the host states no policy', () => {
    const { emit, seen } = harness()
    emit('session/event', { id: 's1' }, { type: 'llm/retry', seq: 8, data: {} })
    expect(seen.retries).toEqual([{ retry: 0, maxRetries: 0, code: 'ERROR' }])
  })

  it('clears the wait when the turn settles', () => {
    const { emit, seen } = harness()
    emit('session/event', { id: 's1' }, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(seen.ends).toBe(1)
    expect(seen.entries).toHaveLength(1)
  })

  it('reports a presented deliverable as a notice', () => {
    const { emit, seen } = harness()
    emit('session/event', { id: 's1' }, {
      type: 'deliverables/presented',
      seq: 6,
      data: { turn: 2, files: [{ path: 'report.md', description: 'summary' }] },
    })
    expect(seen.notices).toEqual(['Deliverables · 1 file(s)\n0. report.md — summary  (turn 2)'])
  })

  it('ignores events from another session', () => {
    const { emit, seen } = harness()
    emit('agent/assistant-stream', { agent: { id: 'other' }, frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } })
    emit('session/event', { id: 'other' }, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(seen.begins).toBe(0)
    expect(seen.ends).toBe(0)
  })
})
