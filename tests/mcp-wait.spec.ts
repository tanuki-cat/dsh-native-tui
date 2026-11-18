import { describe, expect, it, vi } from 'vitest'
import { waitForRetry } from '../src/ui/commands/mcp.js'

describe('waitForRetry', () => {
  it('resolves after the pause when nobody cancels', async () => {
    vi.useFakeTimers()
    try {
      const signal = new AbortController().signal
      let settled = false
      const paused = waitForRetry(250, signal).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(249)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await paused
      expect(settled).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects with the cancellation reason and drops its timer', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const reason = new Error('native-tui: command cancelled')
      const paused = waitForRetry(250, controller.signal)
      controller.abort(reason)
      await expect(paused).rejects.toBe(reason)
      // The cleared timer must not settle anything later.
      await vi.advanceTimersByTimeAsync(250)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects at once when the dispatch was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(waitForRetry(250, controller.signal)).rejects.toThrow('gone')
  })
})
