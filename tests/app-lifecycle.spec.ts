import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShutdown, createSignalExit, formatExitSummary, TranscriptFrames } from '../src/ui/app-lifecycle.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import type { WaitStatusLine } from '../src/ui/waiting.js'

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const user = (seq: number, text: string): TranscriptEntry => ({
  type: 'event',
  event: { type: 'user/message', seq, time: 0, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } as unknown as SessionEvent,
})

afterEach(() => { vi.useRealTimers() })

describe('AppShutdown', () => {
  it('runs one teardown and makes every caller await it', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const task = vi.fn(async (_reportSession: boolean) => { await gate })
    const shutdown = new AppShutdown(task)
    const first = shutdown.dispose()
    const second = shutdown.dispose(false)
    // Concurrent callers share the promise and the first call's report choice.
    expect(second).toBe(first)
    expect(shutdown.disposed).toBe(true)
    expect(task).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(task).toHaveBeenCalledOnce()
    expect(task).toHaveBeenCalledWith(true)
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('claims one process exit and refuses a claim after teardown started', async () => {
    const shutdown = new AppShutdown(async () => {})
    expect(shutdown.exiting).toBe(false)
    expect(shutdown.claimExit()).toBe(true)
    expect(shutdown.exiting).toBe(true)
    expect(shutdown.claimExit()).toBe(false)
    await shutdown.dispose()

    const disposing = new AppShutdown(async () => {})
    const disposal = disposing.dispose()
    expect(disposing.claimExit()).toBe(false)
    await disposal
  })
})

describe('signal exit', () => {
  it('tears down once and exits 143 even when the handler fires twice', async () => {
    const task = vi.fn(async () => {})
    const exit = vi.fn()
    const handler = createSignalExit(new AppShutdown(task), exit)
    handler()
    handler()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
    expect(exit).toHaveBeenCalledWith(143)
    expect(task).toHaveBeenCalledOnce()
  })

  it('still exits when teardown rejects', async () => {
    const exit = vi.fn()
    const handler = createSignalExit(new AppShutdown(async () => { throw new Error('host refused to close') }), exit)
    handler()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143))
  })
})

describe('exit summary', () => {
  it('removes terminal instructions from both lines', () => {
    const summary = formatExitSummary('session\u001b]0;owned\u0007', 'dsh --resume x\u001b[2J')
    expect(summary).not.toContain('\u001b')
    expect(summary).not.toContain('\u0007')
    expect(summary).toBe('\nSession: session\nResume: dsh --resume x\n')
  })
})

describe('TranscriptFrames', () => {
  function harness(disposed = false, maxEntries = options.maxEntries) {
    const renderer = new TranscriptRenderer({ ...options, maxEntries })
    const setText = vi.fn()
    const tui = { requestRender: vi.fn(), onPaint: undefined as ((durationMs: number) => void) | undefined }
    let frames: TranscriptFrames
    const renderFrame = vi.fn(() => { frames.render([], [], undefined) })
    frames = new TranscriptFrames({
      tui,
      renderer,
      waitStatus: { setText } as unknown as WaitStatusLine,
      columns: () => 80,
      disposed: () => disposed,
    }, renderFrame)
    return { renderer, setText, tui, renderFrame, frames }
  }

  it('warms the tree once and skips a frame that would paint the same rows', () => {
    const h = harness()
    const entries = [user(1, 'hello')]
    h.frames.warm(entries, [], undefined)
    expect(h.renderer.container.render(80).join('\n')).toContain('hello')
    const retained = h.frames.render(entries, [], undefined)
    expect(retained).toBe(0)
    expect(h.tui.requestRender).toHaveBeenCalledOnce()
    h.frames.render(entries, [], undefined)
    expect(h.tui.requestRender).toHaveBeenCalledOnce()
  })

  it('reports how many leading entries the retained rows no longer need', () => {
    const h = harness(false, 1)
    const entries = [user(1, 'first'), user(2, 'second')]
    const retained = h.frames.render(entries, [], undefined)
    expect(retained).toBe(1)
  })

  it('does not render or schedule after disposal', () => {
    const h = harness(true)
    expect(h.frames.render([user(1, 'hello')], [], undefined)).toBe(0)
    h.frames.schedule(true)
    expect(h.renderFrame).not.toHaveBeenCalled()
    expect(h.renderer.container.render(80)).toEqual([])
  })

  it('keeps the wait row ticking once a second and stops on clear', () => {
    vi.useFakeTimers()
    const h = harness()
    h.frames.beginWait()
    // The first frame lands on the streaming cadence, not synchronously.
    vi.advanceTimersByTime(50)
    expect(h.setText).toHaveBeenCalled()
    const initial = h.renderFrame.mock.calls.length
    expect(initial).toBeGreaterThan(0)
    vi.advanceTimersByTime(1000)
    expect(h.renderFrame.mock.calls.length).toBe(initial + 1)
    h.frames.clear()
    vi.advanceTimersByTime(5000)
    expect(h.renderFrame.mock.calls.length).toBe(initial + 1)
  })
})
