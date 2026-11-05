import { describe, expect, it, vi } from 'vitest'
import { readContextBreakdown, readContextMeter } from '../src/runtime/agent.js'
import { subscribeSessionEvents, type SessionEventsHost } from '../src/ui/session-events.js'
import { commandFixture } from './rc1-command-fixture.js'

it('reads pressure and composition from the same scoped snapshot without asking the registry twice', () => {
  const values = { contextPressure: { contextWindow: 1000, projectedTokens: 100 }, contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 70 } }
  const projections = { snapshot: vi.fn(() => ({ values })) }
  const session = { snapshotEvents: () => [], requestHeader: () => undefined } as never
  const snapshot = projections.snapshot().values
  expect(readContextMeter(projections, session, 20, snapshot)).toMatchObject({ window: 1000, reading: { tokens: 100 } })
  expect(readContextBreakdown(projections, session, 100, snapshot)).toMatchObject({ systemTokens: 10, toolsTokens: 20, messageTokens: 70 })
  expect(projections.snapshot).toHaveBeenCalledTimes(1)
})

describe('projection-driven status updates', () => {
  it('paints once for a relevant event batch and releases its subscriber on disposal', () => {
    const listeners = new Set<(session: { id: string }, changes: { key: string; val: unknown }[], seq: number) => void>()
    const projections = { onEventChanged: (listener: (session: { id: string }, changes: { key: string; val: unknown }[], seq: number) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } }
    const f = commandFixture({ sessionProjections: projections }), renderStatus = vi.fn()
    const wiring = { host: f.ctx.host, sessionId: () => 'session-1', renderStatus,
      appendEntry: vi.fn(), replaceEntries: vi.fn(), notice: vi.fn(), scheduleTranscript: vi.fn(),
      beginWait: vi.fn(), endWait: vi.fn(), retryScheduled: vi.fn(), beginAttempt: vi.fn(), endAttempt: vi.fn(), nextLiveSeq: () => 1, attemptPosition: () => undefined,
    } as unknown as SessionEventsHost
    const dispose = subscribeSessionEvents(wiring)
    const emit = (id: string, keys: string[]) => { for (const listener of listeners) listener({ id }, keys.map(key => ({ key, val: null })), 1) }
    emit('other', ['sessionStats']); emit('session-1', ['todos'])
    expect(renderStatus).not.toHaveBeenCalled()
    emit('session-1', ['sessionStats', 'contextPressure', 'contextBreakdown'])
    expect(renderStatus).toHaveBeenCalledTimes(1)
    dispose(); expect(listeners.size).toBe(0); expect(f.listenerCount()).toBe(0)
    emit('session-1', ['sessionStats']); expect(renderStatus).toHaveBeenCalledTimes(1)
  })
})
