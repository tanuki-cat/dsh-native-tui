import { describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { modeCommand } from '../src/ui/commands/mode.js'
import { permissionsCommand } from '../src/ui/commands/runtime-status.js'
import { runCommandLine, type CommandRouterDeps } from '../src/ui/commands/router.js'
import { createPalette } from '../src/ui/theme.js'
import { INTERACTION_MODES, type InteractionMode } from '../src/interaction-modes.js'

function harness() {
  let current: InteractionMode = 'accept-edits'
  const controller = new AbortController()
  const overlays: Array<{ handleInput(data: string): void; render(width: number): string[] }> = []
  const modes = {
    current: () => current,
    available: vi.fn((): readonly InteractionMode[] => INTERACTION_MODES),
    set: vi.fn((_agent: unknown, mode: InteractionMode) => { current = mode }),
  }
  const raw = {
    set: vi.fn(), current: () => 'workspace-write',
    names: ['read-only', 'workspace-write', 'danger-full-access', 'manual', 'accept-edits', 'plan', 'auto', 'custom'],
    resolve: (name: string) => ({ sandbox: name === 'read-only' ? 'read-only' : name === 'workspace-write' ? 'workspace-write' : 'danger-full-access', approval: name === 'danger-full-access' ? 'never' : 'ask' }),
  }
  const ctx = {
    host: { get: (name: string) => name === 'interactionModes' ? modes : raw },
    active: { agent: { status: 'idle', session: {} } }, signal: controller.signal,
    palette: createPalette('plain'),
    tui: { showOverlay: (dialog: typeof overlays[number]) => { overlays.push(dialog); return { hide() {} } } },
    notice: vi.fn(), renderStatus: vi.fn(),
  } as unknown as CommandContext & { notice: ReturnType<typeof vi.fn>; renderStatus: ReturnType<typeof vi.fn> }
  return { ctx, modes, raw, overlays, controller, get current() { return current } }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('mode command', () => {
  it.each(['manual', 'plan', 'accept edits', 'off'] as const)('selects %s without sending a prompt', async target => {
    const h = harness()
    if (target === 'accept edits') h.modes.current = () => 'manual'
    await modeCommand(h.ctx, target)
    expect(h.modes.set).toHaveBeenCalledWith(h.ctx.active.agent, target.replace(' ', '-'))
    expect(h.ctx.renderStatus).toHaveBeenCalledOnce()
  })

  it('opens a picker with the available modes and marks the current one', async () => {
    const h = harness()
    const running = modeCommand(h.ctx, '')
    expect(h.overlays[0]?.render(100).join(' ')).toContain('* accept edits')
    expect(h.overlays[0]?.render(100).join(' ')).toContain('off')
    h.overlays[0]!.handleInput('\x1b[B')
    h.overlays[0]!.handleInput('\x1b[B')
    h.overlays[0]!.handleInput('\r')
    await running
    expect(h.current).toBe('plan')
  })

  it('keeps Auto disabled when the risk dialog is cancelled or Enter keeps the default', async () => {
    for (const key of ['\r', '\x1b']) {
      const h = harness()
      const running = modeCommand(h.ctx, 'auto')
      expect(h.overlays[0]?.render(100).join(' ')).toContain('Full file access')
      h.overlays[0]!.handleInput(key)
      await running
      expect(h.modes.set).not.toHaveBeenCalled()
    }
  })

  it('requires explicit consent before enabling the Host Auto reviewer', async () => {
    const h = harness()
    const running = modeCommand(h.ctx, 'auto')
    h.overlays[0]!.handleInput('\x1b[B')
    h.overlays[0]!.handleInput('\r')
    await running
    expect(h.current).toBe('auto')
    expect(h.ctx.notice).toHaveBeenCalledWith('info', 'Mode: auto mode')
  })

  it('does not offer a fake Auto option when no reviewer is registered', async () => {
    const h = harness()
    h.modes.available.mockReturnValue(['manual', 'accept-edits', 'plan'])
    await modeCommand(h.ctx, 'auto')
    expect(h.overlays).toHaveLength(0)
    expect(h.modes.set).not.toHaveBeenCalled()
    expect(h.ctx.notice.mock.calls[0]?.[1]).toContain('unavailable')
  })

  it('does not change modes while the agent is running', async () => {
    const h = harness()
    Object.assign(h.ctx.active.agent, { status: 'running' })
    await modeCommand(h.ctx, 'plan')
    expect(h.modes.set).not.toHaveBeenCalled()
    expect(h.overlays).toHaveLength(0)
  })

  it('does not switch after cancellation while the picker is open', async () => {
    const h = harness()
    const running = modeCommand(h.ctx, '')
    h.controller.abort()
    await running
    expect(h.modes.set).not.toHaveBeenCalled()
  })

  it('contains a service error without reporting success', async () => {
    const h = harness()
    h.modes.set.mockImplementationOnce(() => { throw new Error('policy changed') })
    await modeCommand(h.ctx, 'manual')
    expect(h.ctx.notice).toHaveBeenCalledWith('error', 'Could not change mode: policy changed')
    expect(h.ctx.renderStatus).not.toHaveBeenCalled()
  })

  it('does not treat bypassPermissions or an invalid value as Auto', async () => {
    const h = harness()
    await modeCommand(h.ctx, 'bypassPermissions')
    expect(h.modes.set).not.toHaveBeenCalled()
    expect(h.ctx.notice.mock.calls[0]?.[1]).toContain('Usage:')
  })

  it.each(['/permissions', '/permission'])('opens the native picker through %s and applies the selection', async command => {
    const h = harness()
    h.modes.current = () => 'off'
    const running = runCommandLine(command, { context: () => h.ctx } as unknown as CommandRouterDeps)
    const text = h.overlays[0]!.render(76).join(' ')
    expect(text).toContain('Permission preset (current: workspace-write)')
    expect(text).toContain('* workspace-write')
    expect(text).toContain('read-only')
    expect(text).toContain('danger-full-access')
    expect(text).toContain('custom')
    expect(text).toContain('read-only · approval: ask')
    expect(text).toContain('danger-full-access · approval: never')
    expect(text).not.toContain('accept-edits')
    expect(text).not.toContain('auto')
    h.overlays[0]!.handleInput('\r')
    await running
    expect(h.raw.set).toHaveBeenCalledWith(h.ctx.active.agent.session, 'read-only')
    expect(h.modes.set).not.toHaveBeenCalled()
    expect(h.ctx.renderStatus).toHaveBeenCalledOnce()
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access', 'custom'])('selects native %s directly', async preset => {
    const h = harness()
    await permissionsCommand(h.ctx, preset)
    expect(h.raw.set).toHaveBeenCalledWith(h.ctx.active.agent.session, preset)
    expect(h.overlays).toHaveLength(0)
    expect(h.modes.set).not.toHaveBeenCalled()
  })

  it('cancels the native picker without changing permissions', async () => {
    const h = harness()
    const running = permissionsCommand(h.ctx, '')
    h.overlays[0]!.handleInput('\x1b')
    await running
    expect(h.raw.set).not.toHaveBeenCalled()
  })

  it.each(['running', 'plan', 'aborted', 'removed'] as const)('revalidates %s state after the native picker opens', async state => {
    const h = harness()
    const running = permissionsCommand(h.ctx, '')
    if (state === 'running') Object.assign(h.ctx.active.agent, { status: 'running' })
    if (state === 'plan') h.modes.current = () => 'plan'
    if (state === 'aborted') h.controller.abort()
    if (state === 'removed') h.raw.names = ['workspace-write']
    h.overlays[0]!.handleInput('\r')
    await running
    expect(h.raw.set).not.toHaveBeenCalled()
    expect(h.ctx.renderStatus).not.toHaveBeenCalled()
  })

  it('does not open the native picker while in plan mode or running', async () => {
    for (const state of ['plan', 'running']) {
      const h = harness()
      if (state === 'plan') h.modes.current = () => 'plan'
      else Object.assign(h.ctx.active.agent, { status: 'running' })
      await permissionsCommand(h.ctx, '')
      expect(h.overlays).toHaveLength(0)
      expect(h.raw.set).not.toHaveBeenCalled()
    }
  })

  it('reports a failed native permission change without success', async () => {
    const h = harness()
    h.raw.set.mockImplementationOnce(() => { throw new Error('preset unavailable') })
    await permissionsCommand(h.ctx, 'read-only')
    expect(h.ctx.notice).toHaveBeenCalledWith('error', 'Could not change permissions: preset unavailable')
    expect(h.ctx.renderStatus).not.toHaveBeenCalled()
  })

  it.each(['mode', 'permissions'])('recovers %s on the new Agent only after resetting shells', async command => {
    const h = harness()
    Object.assign(h.ctx.active, { id: 'session-1' })
    const reopened = { ...h.ctx.active, agent: { ...h.ctx.active.agent, session: {} } }
    const restart = vi.fn(async () => reopened)
    Object.assign(h.ctx, { restartSession: restart })
    const setter = command === 'mode' ? h.modes.set : h.raw.set
    setter.mockImplementationOnce(() => { throw new Error('cannot change sandbox mode from "workspace-write" to "read-only" while persistent terminal sessions are open or being created; wait for creation to settle and close them first') })
    const running = command === 'mode' ? modeCommand(h.ctx, 'manual') : permissionsCommand(h.ctx, 'read-only')
    await flush()
    expect(restart).not.toHaveBeenCalled()
    h.overlays[0]!.handleInput('\x1b[B'); h.overlays[0]!.handleInput('\r')
    await running
    expect(restart).toHaveBeenCalledExactlyOnceWith(h.ctx.active)
    if (command === 'mode') expect(h.modes.set).toHaveBeenLastCalledWith(reopened.agent, 'manual')
    else {
      expect(h.raw.set).toHaveBeenNthCalledWith(2, h.ctx.active.agent.session, 'workspace-write')
      expect(h.raw.set).toHaveBeenLastCalledWith(reopened.agent.session, 'read-only')
    }
    expect(h.ctx.renderStatus).toHaveBeenCalledOnce()
  })

  it('keeps advanced /permissions from widening a live plan sandbox', async () => {
    const h = harness()
    h.modes.current = () => 'plan'
    await permissionsCommand(h.ctx, 'danger-full-access')
    expect(h.raw.set).not.toHaveBeenCalled()
    expect(h.ctx.notice.mock.calls[0]?.[1]).toContain('Leave plan mode')
  })

  it('routes /permissions auto through the same explicit consent', async () => {
    const h = harness()
    const running = permissionsCommand(h.ctx, 'auto')
    await flush()
    expect(h.overlays).toHaveLength(1)
    h.overlays[0]!.handleInput('\x1b')
    await running
    expect(h.raw.set).not.toHaveBeenCalled()
    expect(h.modes.set).not.toHaveBeenCalled()
  })
})
