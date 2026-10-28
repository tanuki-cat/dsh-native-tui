import { describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { loginCommand } from '../src/ui/commands/login.js'
import { runCommandLine, type CommandRouterDeps } from '../src/ui/commands/router.js'
import { createPalette } from '../src/ui/theme.js'

function harness() {
  const controller = new AbortController()
  const overlays: Array<{ handleInput(data: string): void; render(width: number): string[] }> = []
  const hide = vi.fn()
  const runCommand = vi.fn(async (_line: string): Promise<void> => undefined)
  const notice = vi.fn()
  let current = true
  const ctx = {
    host: { get: () => undefined },
    signal: controller.signal,
    isCurrent: () => current,
    palette: createPalette('plain'),
    tui: { showOverlay: (dialog: typeof overlays[number]) => { overlays.push(dialog); return { hide } } },
    runCommand,
    notice,
  } as unknown as CommandContext
  const select = (index: number) => {
    for (let i = 0; i < index; i += 1) overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
  }
  return { ctx, controller, overlays, hide, runCommand, notice, select, replaceSession: () => { current = false } }
}

describe('guided login command', () => {
  it.each(['codebuddy', 'codex'])('routes the selected %s platform through its existing login', async provider => {
    const h = harness()
    const running = loginCommand(h.ctx, '')
    const text = h.overlays[0]!.render(100).join(' ')
    expect(text).toContain('选择登录平台')
    expect(text).toContain('CodeBuddy / WorkBuddy')
    expect(text).toContain('ChatGPT Codex')
    expect(text).toContain('DeepSeek 官方（待实现）')
    expect(h.runCommand).not.toHaveBeenCalled()
    h.select(provider === 'codebuddy' ? 0 : 1)
    await running
    expect(h.runCommand).toHaveBeenCalledExactlyOnceWith('/' + provider + ' login')
    expect(h.hide).toHaveBeenCalledOnce()
  })

  it('reports the pending DeepSeek implementation without starting authorization', async () => {
    const h = harness()
    const running = loginCommand(h.ctx, '')
    h.select(2)
    await running
    expect(h.notice).toHaveBeenCalledWith('info', 'DeepSeek 官方登录待实现，请使用 /provider 配置 API Key。')
    expect(h.runCommand).not.toHaveBeenCalled()
  })

  it.each(['escape', 'abort', 'replaced', 'abort-after-select'])('does not start login after %s', async action => {
    const h = harness()
    const running = loginCommand(h.ctx, '')
    if (action === 'escape') h.overlays[0]!.handleInput('\x1b')
    if (action === 'abort') h.controller.abort()
    if (action === 'replaced') { h.replaceSession(); h.select(0) }
    if (action === 'abort-after-select') { h.select(0); h.controller.abort() }
    await running
    expect(h.runCommand).not.toHaveBeenCalled()
    expect(h.notice).not.toHaveBeenCalled()
    expect(h.hide).toHaveBeenCalledOnce()
  })

  it('does not open the picker for an already aborted command', async () => {
    const h = harness()
    h.controller.abort()
    await loginCommand(h.ctx, '')
    expect(h.overlays).toHaveLength(0)
    expect(h.runCommand).not.toHaveBeenCalled()
  })

  it.each(['codebuddy', 'codex device', 'deepseek', 'unknown'])('rejects platform subcommands: %s', async args => {
    const h = harness()
    await loginCommand(h.ctx, args)
    expect(h.overlays).toHaveLength(0)
    expect(h.runCommand).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('warning', '用法：/login，请在引导窗口选择登录平台。')
  })

  it.each([
    ['codebuddy', 0, 'no authorization service'],
    ['codex', 1, 'unavailable'],
  ] as const)('dispatches /login into the existing %s handler', async (_provider, index, expected) => {
    const h = harness()
    const deps = { context: () => h.ctx } as unknown as CommandRouterDeps
    h.runCommand.mockImplementation(line => runCommandLine(line, deps))
    const running = runCommandLine('/login', deps)
    h.select(index)
    await running
    expect(h.notice.mock.calls.map(call => call[1]).join(' ')).toContain(expected)
  })
})
