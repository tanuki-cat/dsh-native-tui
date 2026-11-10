import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { CommandContext } from '../src/ui/commands/context.js'
import { diffCommand, toolCommand, toolsCommand } from '../src/ui/commands/tools.js'
import { createPalette } from '../src/ui/theme.js'
import { createTerminalTheme } from '../src/ui/terminal-theme.js'

function context(events: readonly unknown[]) {
  const notice = vi.fn()
  const controller = new AbortController()
  let overlay: Component
  let input: ((data: string) => unknown) | undefined
  const tui = { terminal: { rows: 30 }, requestRender() {},
    showOverlay(component: Component) { overlay = component; return { hide() {}, focus() {} } },
    addInputListener(listener: typeof input) { input = listener; return () => { input = undefined } },
  }
  onTestFinished(() => { controller.abort() })
  return { palette: createPalette('plain'), tui, notice, signal: controller.signal,
    active: { agent: { session: { snapshotEvents: () => events } } },
    output: (width = 80) => overlay.render(width).join('\n'), close: () => input?.('\x1b'),
  } as unknown as CommandContext & { notice: typeof notice; output: (width?: number) => string; close: () => void }
}

function nested(index: number) {
  return { type: 'tool/ptc-dispatch', data: { subCallId: 'nested-' + index, name: 'write',
    arguments: { file_path: 'file-' + index + '.ts', content: 'new-' + index },
    content: [{ type: 'text', text: 'Updated file' }],
    meta: { diffs: [{ path: 'file-' + index + '.ts', oldText: 'old-' + index, newText: 'new-' + index }] },
  } }
}

describe('tool inspection commands', () => {
  it('opens the latest nested PTC diff', async () => {
    const ctx = context([nested(0), nested(1)])
    const opened = diffCommand(ctx, '')
    const text = ctx.output()
    expect(text).toContain('nested-1')
    expect(text).toContain('- old-1')
    expect(text).toContain('+ new-1')
    expect(text).not.toContain('old-0')
    expect(ctx.notice).not.toHaveBeenCalled()
    ctx.close()
    await opened
  })

  it('uses the same retained indices for /tools, /tool and /diff', async () => {
    const ctx = context(Array.from({ length: 55 }, (_, index) => nested(index)))
    toolsCommand(ctx)
    expect(ctx.notice.mock.calls[0]?.[1]).toContain('49. write')
    const tool = toolCommand(ctx, '0')
    expect(ctx.output()).toContain('nested-5')
    ctx.close()
    await tool
    const diff = diffCommand(ctx, '0')
    expect(ctx.output()).toContain('nested-5')
    expect(ctx.output()).toContain('- old-5')
    ctx.close()
    await diff
  })

  it('keeps the no-diff notice when dispatch results have no diff metadata', async () => {
    const item = nested(0)
    const ctx = context([{ ...item, data: { ...item.data, meta: { diffs: [] } } }])
    await diffCommand(ctx, '')
    expect(ctx.notice).toHaveBeenCalledWith('info', 'No file diffs recorded in this session yet.')
  })

  it('renders numbered diff bands through the real pager and follows terminal colors', async () => {
    const ctx = context([nested(0)])
    const theme = createTerminalTheme('auto', 'truecolor')
    Object.assign(ctx, { palette: theme.palette })
    const opened = diffCommand(ctx, '')
    const dark = ctx.output()
    expect(dark).toContain('48;5;22m')
    expect(dark).toContain('48;5;52m')
    expect(stripTerminalSequences(dark)).toContain('1 - old-0')
    expect(stripTerminalSequences(dark)).toContain('1 + new-0')
    theme.update({ background: { r: 255, g: 255, b: 255 }, foreground: { r: 20, g: 20, b: 20 } })
    const light = ctx.output(38)
    expect(light).toContain('48;5;194m')
    expect(light).toContain('48;5;224m')
    expect(light.split('\n').every(line => visibleWidth(line) <= 38)).toBe(true)
    ctx.close()
    await opened
  })

  it('keeps terminal instructions out of diff paths and source rows', async () => {
    const event = nested(0)
    event.data.meta.diffs[0] = { path: '\x1b]52;c;BAD\x07safe.ts', oldText: 'before\x1b[2J', newText: 'after\x1b[31m' }
    const ctx = context([event]), opened = diffCommand(ctx, '')
    const output = ctx.output()
    expect(output).toContain('safe.ts')
    expect(output).not.toMatch(/\x1b/u)
    ctx.close()
    await opened
  })
})
