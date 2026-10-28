import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HostSession } from '../src/runtime/agent.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { changePermissions } from '../src/ui/commands/permission-change.js'
import { createPalette } from '../src/ui/theme.js'

const fence = () => new Error('cannot change sandbox mode from "workspace-write" to "read-only" while persistent terminal sessions are open or being created; wait for creation to settle and close them first')
function harness() {
  const abort = new AbortController()
  const overlays: Array<{ handleInput(data: string): void; render(width: number): string[] }> = []
  const active = { id: 'session-1', agent: { status: 'idle' } } as HostSession
  const reopened = { id: active.id, agent: { status: 'idle' } } as HostSession
  const restartSession = vi.fn(async () => reopened)
  const ctx = { active, signal: abort.signal, palette: createPalette('plain'), restartSession,
    tui: { showOverlay: (dialog: typeof overlays[number]) => { overlays.push(dialog); return { hide() {} } } },
  } as unknown as CommandContext
  return { ctx, abort, overlays, active, reopened, restartSession }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const confirm = (h: ReturnType<typeof harness>) => { h.overlays[0]!.handleInput('\x1b[B'); h.overlays[0]!.handleInput('\r') }

describe('permission change recovery', () => {
  it('does not restart or prompt when permissions can change normally', async () => {
    const h = harness(), change = vi.fn()
    expect(await changePermissions(h.ctx, change)).toBe(true)
    expect(change).toHaveBeenCalledExactlyOnceWith(h.active.agent)
    expect(h.restartSession).not.toHaveBeenCalled()
    expect(h.overlays).toHaveLength(0)
  })

  it('retries on the replacement Agent only after an awaited, explicitly confirmed restart', async () => {
    const h = harness()
    let finish!: (value: HostSession) => void
    h.restartSession.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const change = vi.fn((_agent: Agent): void => {}).mockImplementationOnce(() => { throw fence() })
    const running = changePermissions(h.ctx, change)
    await flush()
    expect(h.overlays[0]!.render(76).join(' ').replaceAll('│', ' ').replace(/\s+/g, ' ')).toContain('conversation history is preserved')
    expect(change).toHaveBeenCalledTimes(1)
    expect(h.restartSession).not.toHaveBeenCalled()
    confirm(h)
    await flush()
    expect(h.restartSession).toHaveBeenCalledExactlyOnceWith(h.active)
    expect(change).toHaveBeenCalledTimes(1)
    finish(h.reopened)
    expect(await running).toBe(true)
    expect(change).toHaveBeenLastCalledWith(h.reopened.agent)
  })

  it.each(['enter', 'escape', 'abort'])('keeps the current Agent when the reset dialog is cancelled by %s', async action => {
    const h = harness(), change = vi.fn(() => { throw fence() })
    const running = changePermissions(h.ctx, change)
    await flush()
    if (action === 'abort') h.abort.abort()
    else h.overlays[0]!.handleInput(action === 'enter' ? '\r' : '\x1b')
    expect(await running).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    expect(h.restartSession).not.toHaveBeenCalled()
  })

  it('does not retry unrelated errors or restart failures', async () => {
    const h = harness()
    await expect(changePermissions(h.ctx, () => { throw new Error('policy unavailable') })).rejects.toThrow('policy unavailable')
    expect(h.overlays).toHaveLength(0)
    h.restartSession.mockRejectedValueOnce(new Error('cleanup failed'))
    const change = vi.fn(() => { throw fence() }), running = changePermissions(h.ctx, change)
    await flush(); confirm(h)
    await expect(running).rejects.toThrow('cleanup failed')
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('preserves the original error when no restart hook is available', async () => {
    const h = harness()
    Object.assign(h.ctx, { restartSession: undefined })
    await expect(changePermissions(h.ctx, () => { throw fence() })).rejects.toThrow('persistent terminal sessions')
    expect(h.overlays).toHaveLength(0)
  })

  it('does not retry a second terminal fence', async () => {
    const h = harness(), change = vi.fn(() => { throw fence() })
    const running = changePermissions(h.ctx, change)
    await flush(); confirm(h)
    await expect(running).rejects.toThrow('persistent terminal sessions')
    expect(change).toHaveBeenCalledTimes(2)
    expect(h.restartSession).toHaveBeenCalledOnce()
  })

  it('stops if cancelled while the restart is in progress', async () => {
    const h = harness(), change = vi.fn().mockImplementationOnce(() => { throw fence() })
    h.restartSession.mockImplementationOnce(async () => { h.abort.abort(); return h.reopened })
    const running = changePermissions(h.ctx, change)
    await flush(); confirm(h)
    expect(await running).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('rejects a different Session and a running Agent before retrying', async () => {
    const h = harness(), change = vi.fn().mockImplementationOnce(() => { throw fence() })
    h.restartSession.mockResolvedValueOnce({ ...h.reopened, id: 'different-session' } as HostSession)
    const running = changePermissions(h.ctx, change)
    await flush(); confirm(h)
    await expect(running).rejects.toThrow('different Session')
    expect(change).toHaveBeenCalledTimes(1)
    Object.assign(h.active.agent, { status: 'running' })
    await expect(changePermissions(h.ctx, change)).rejects.toThrow('running turn')
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('refuses to reset if a turn starts while the confirmation dialog is open', async () => {
    const h = harness(), change = vi.fn(() => { throw fence() })
    const running = changePermissions(h.ctx, change)
    await flush(); Object.assign(h.active.agent, { status: 'running' }); confirm(h)
    await expect(running).rejects.toThrow('running turn')
    expect(h.restartSession).not.toHaveBeenCalled()
  })
})
