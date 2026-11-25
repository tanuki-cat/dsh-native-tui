import { describe, expect, it, vi } from 'vitest'
import {
  handOverSession,
  resetInteractionScope,
  runGlobalShortcut,
  shortcutDisposition,
  type GlobalShortcutActions,
  type SessionHandover,
} from '../src/ui/app-session.js'
import type { GlobalShortcut } from '../src/ui/keymap.js'

interface FakeSession { readonly id: string }

function handover(overrides: Partial<SessionHandover<FakeSession>> = {}): {
  readonly options: SessionHandover<FakeSession>
  readonly detach: ReturnType<typeof vi.fn>
  readonly attach: ReturnType<typeof vi.fn>
  readonly adopt: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
} {
  const detach = vi.fn()
  const attach = vi.fn()
  const adopt = vi.fn()
  const release = vi.fn(async () => {})
  const current: FakeSession = { id: 'current' }
  const next: FakeSession = { id: 'next' }
  const options: SessionHandover<FakeSession> = {
    current,
    open: async () => next,
    release,
    detach,
    attach,
    adopt,
    ...overrides,
  }
  return { options, detach, attach, adopt, release }
}

describe('session handover', () => {
  it('releases the outgoing session and adopts the replacement', async () => {
    const h = handover()
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'switched', session: { id: 'next' } })
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.release).toHaveBeenCalledWith({ id: 'current' })
    expect(h.adopt).toHaveBeenCalledWith({ id: 'next' })
    expect(h.attach).not.toHaveBeenCalled()
  })

  it('re-attaches the outgoing session when its disposal fails', async () => {
    // The screen still belongs to the old Agent: a failed release must not
    // leave the terminal disconnected from a session that is still running.
    const failure = new Error('host refused to close')
    const h = handover({ release: async () => { throw failure } })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'failed', restorable: true, error: failure })
    expect(result.status === 'failed' ? result.unopened : undefined).toMatchObject({ id: 'next' })
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.attach).toHaveBeenCalledOnce()
    expect(h.adopt).not.toHaveBeenCalled()
  })

  it('keeps the outgoing session attached when opening the replacement fails', async () => {
    const failure = new Error('resume failed')
    const h = handover({ open: async () => { throw failure } })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'failed', restorable: true, error: failure })
    expect(h.detach).not.toHaveBeenCalled()
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
  })

  it('detaches before a restart because the opener releases the old session', async () => {
    const h = handover({ closedByOpener: true })
    const order: string[] = []
    h.detach.mockImplementation(() => { order.push('detach') })
    const options: SessionHandover<FakeSession> = {
      ...h.options,
      open: async () => { order.push('open'); return { id: 'next' } },
    }
    const result = await handOverSession(options)
    expect(result.status).toBe('switched')
    expect(order).toEqual(['detach', 'open'])
    expect(h.release).not.toHaveBeenCalled()
    expect(h.adopt).toHaveBeenCalledOnce()
  })

  it('reports a restart failure as irrecoverable instead of re-attaching', async () => {
    // A restart closes the old Agent itself, so there is no handle to return
    // to; the caller must keep prompts blocked until a reload.
    const failure = new Error('resume failed')
    const h = handover({ closedByOpener: true, open: async () => { throw failure } })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'failed', restorable: false, error: failure })
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.attach).not.toHaveBeenCalled()
  })

  it('re-attaches when a restart fails before disposing the outgoing session', async () => {
    const failure = new Error('turn still running')
    const h = handover({
      closedByOpener: true,
      previousClosed: () => false,
      open: async () => { throw failure },
    })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'failed', restorable: true, error: failure })
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.attach).toHaveBeenCalledOnce()
  })

  it('returns an opened replacement when the application was disposed meanwhile', async () => {
    const h = handover({ aborted: () => true })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'aborted', unopened: { id: 'next' } })
    expect(h.detach).not.toHaveBeenCalled()
    expect(h.adopt).not.toHaveBeenCalled()
  })

  it('leaves a same-session open untouched', async () => {
    const current: FakeSession = { id: 'current' }
    const h = handover({ current, open: async () => current })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'same' })
    expect(h.detach).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.adopt).not.toHaveBeenCalled()
  })

  it('returns a replacement whose adoption failed for the caller to release', async () => {
    const failure = new Error('adopt failed')
    const h = handover({ adopt: () => { throw failure } })
    const result = await handOverSession(h.options)
    expect(result).toMatchObject({ status: 'failed', restorable: false, error: failure })
    expect(result.status === 'failed' ? result.unopened : undefined).toMatchObject({ id: 'next' })
    expect(h.attach).not.toHaveBeenCalled()
  })
})

describe('shortcut gating', () => {
  it('lets a dialog keep a key with no shortcut while a session switches', () => {
    // Escape in an open dialog maps to no global shortcut; swallowing it kept
    // the dialog and the switch waiting on each other.
    expect(shortcutDisposition(undefined, { switching: true, processingPaste: false })).toBe('handle')
  })

  it('defers shortcuts while an asynchronous paste drains', () => {
    expect(shortcutDisposition('clear-input', { switching: false, processingPaste: true })).toBe('defer')
    expect(shortcutDisposition('exit', { switching: false, processingPaste: true })).toBe('handle')
  })

  it('swallows gated shortcuts during a switch but keeps exit and cancellation live', () => {
    expect(shortcutDisposition('clear-input', { switching: true, processingPaste: false })).toBe('swallow')
    expect(shortcutDisposition('new-session', { switching: true, processingPaste: false })).toBe('swallow')
    expect(shortcutDisposition('exit', { switching: true, processingPaste: false })).toBe('handle')
    expect(shortcutDisposition('cancel-turn', { switching: true, processingPaste: false })).toBe('handle')
  })
})

describe('interaction scope', () => {
  it('cancels the outgoing session dialogs and opens a live scope', () => {
    const scope = new AbortController()
    const tui = { hasOverlay: vi.fn(() => true), hideOverlay: vi.fn() }
    const next = resetInteractionScope(scope, tui)
    expect(scope.signal.aborted).toBe(true)
    expect(tui.hideOverlay).toHaveBeenCalledOnce()
    expect(next.signal.aborted).toBe(false)
    expect(next).not.toBe(scope)
  })

  it('does not touch an overlay it does not need to close', () => {
    const scope = new AbortController()
    const tui = { hasOverlay: vi.fn(() => false), hideOverlay: vi.fn() }
    resetInteractionScope(scope, tui)
    expect(tui.hideOverlay).not.toHaveBeenCalled()
  })
})

describe('global shortcut dispatch', () => {
  function actions() {
    return {
      overlayOpen: (): boolean => false,
      newSession: vi.fn(),
      pickSession: vi.fn(),
      cycleReasoning: vi.fn(),
      toggleToolPreviews: vi.fn(),
      jumpToLatest: vi.fn(),
      clearInput: vi.fn(),
      cancelCommand: vi.fn((): boolean => true),
      cancelTurn: vi.fn(),
      exit: vi.fn(),
    } satisfies GlobalShortcutActions
  }
  const all: readonly GlobalShortcut[] = ['new-session', 'pick-session', 'cycle-reasoning',
    'toggle-tool-previews', 'jump-to-latest', 'clear-input', 'cancel-command', 'cancel-turn', 'exit']

  it('handles every shortcut instead of falling through to exit', () => {
    for (const shortcut of all) {
      const target = actions()
      expect(runGlobalShortcut(shortcut, target)).toEqual({ consume: true })
      expect(target.exit).toHaveBeenCalledTimes(shortcut === 'exit' ? 1 : 0)
    }
  })

  it('declines shortcuts a dialog would act behind', () => {
    for (const shortcut of ['new-session', 'pick-session', 'cycle-reasoning',
      'toggle-tool-previews', 'cancel-command', 'cancel-turn'] as const) {
      const target = actions()
      target.overlayOpen = () => true
      expect(runGlobalShortcut(shortcut, target)).toBeUndefined()
    }
    const target = actions()
    target.overlayOpen = () => true
    expect(runGlobalShortcut('jump-to-latest', target)).toEqual({ consume: true })
    expect(runGlobalShortcut('clear-input', target)).toEqual({ consume: true })
    expect(runGlobalShortcut('exit', target)).toEqual({ consume: true })
  })

  it('leaves an unstarted cancel to the focused component', () => {
    const target = actions()
    target.cancelCommand = vi.fn(() => false)
    expect(runGlobalShortcut('cancel-command', target)).toBeUndefined()
  })
})
