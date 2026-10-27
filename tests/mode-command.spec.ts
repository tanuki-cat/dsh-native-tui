import { describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { modeCommand } from '../src/ui/commands/mode.js'
import { permissionsCommand } from '../src/ui/commands/runtime-status.js'
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
  const raw = { set: vi.fn(), current: () => 'plan', names: ['danger-full-access'] }
  const ctx = {
    host: { get: (name: string) => name === 'interactionModes' ? modes : raw },
    active: { agent: { status: 'idle' } }, signal: controller.signal,
    palette: createPalette('plain'),
    tui: { showOverlay: (dialog: typeof overlays[number]) => { overlays.push(dialog); return { hide() {} } } },
    notice: vi.fn(), renderStatus: vi.fn(),
  } as unknown as CommandContext & { notice: ReturnType<typeof vi.fn>; renderStatus: ReturnType<typeof vi.fn> }
  return { ctx, modes, raw, overlays, controller, get current() { return current } }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('mode command', () => {
  it.each(['manual', 'plan', 'accept edits'] as const)('selects %s without sending a prompt', async target => {
    const h = harness()
    if (target === 'accept edits') h.modes.current = () => 'manual'
    await modeCommand(h.ctx, target)
    expect(h.modes.set).toHaveBeenCalledWith(h.ctx.active.agent, target.replace(' ', '-'))
    expect(h.ctx.renderStatus).toHaveBeenCalledOnce()
  })

  it('opens a picker with the four available modes and marks the current one', async () => {
    const h = harness()
    const running = modeCommand(h.ctx, '')
    expect(h.overlays[0]?.render(100).join(' ')).toContain('* accept edits')
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
