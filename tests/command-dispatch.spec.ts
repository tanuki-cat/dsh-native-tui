import { describe, expect, it } from 'vitest'
import { CommandDispatchTracker } from '../src/ui/command-dispatch.js'

describe('command dispatch', () => {
  it('tracks one dispatch until its commands settle', () => {
    const tracker = new CommandDispatchTracker(new AbortController().signal)
    expect(tracker.running).toBe(false)
    const outer = tracker.begin()
    expect(tracker.running).toBe(true)
    const nested = tracker.begin()
    expect(nested.signal).not.toBe(outer.signal)
    outer.release()
    expect(tracker.running).toBe(true)
    nested.release()
    expect(tracker.running).toBe(false)
  })

  it('cancels every command of one dispatch through the shared controller', () => {
    const tracker = new CommandDispatchTracker(new AbortController().signal)
    const outer = tracker.begin()
    const nested = tracker.begin()
    expect(tracker.cancel()).toBe(true)
    expect(outer.signal.aborted).toBe(true)
    expect(nested.signal.aborted).toBe(true)
    expect(outer.cancelled()).toBe(true)
    // A second Escape cannot re-cancel a dispatch that already ended.
    expect(tracker.cancel()).toBe(false)
    outer.release()
    nested.release()
    expect(tracker.running).toBe(false)
  })

  it('starts the next command uncancelled after one was cancelled', () => {
    const tracker = new CommandDispatchTracker(new AbortController().signal)
    const cancelled = tracker.begin()
    tracker.cancel()
    cancelled.release()
    const next = tracker.begin()
    expect(next.signal.aborted).toBe(false)
    expect(next.cancelled()).toBe(false)
    expect(tracker.cancel()).toBe(true)
    next.release()
  })

  it('narrows the terminal lifetime without counting its end as a cancellation', () => {
    const lifetime = new AbortController()
    const tracker = new CommandDispatchTracker(lifetime.signal)
    const dispatch = tracker.begin()
    expect(tracker.signal().aborted).toBe(false)
    lifetime.abort(new Error('terminal disposed'))
    expect(dispatch.signal.aborted).toBe(true)
    expect(dispatch.cancelled()).toBe(false)
    expect(tracker.signal().aborted).toBe(true)
    dispatch.release()
    // Without a dispatch the lifetime signal is the surface a context sees.
    expect(tracker.signal()).toBe(lifetime.signal)
  })

  it('clears only when the last command of the dispatch released it', () => {
    const tracker = new CommandDispatchTracker(new AbortController().signal)
    const outer = tracker.begin()
    const nested = tracker.begin()
    nested.release()
    expect(tracker.running).toBe(true)
    outer.release()
    expect(tracker.running).toBe(false)
    const next = tracker.begin()
    expect(next.signal.aborted).toBe(false)
    next.release()
  })
})
