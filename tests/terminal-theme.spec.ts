import { describe, expect, it, vi } from 'vitest'
import type { TerminalColors, TUI } from '@earendil-works/pi-tui'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { createTerminalTheme } from '../src/ui/terminal-theme.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const screenshot: TerminalColors = { foreground: { r: 235, g: 235, b: 235 }, background: { r: 40, g: 42, b: 54 } }
const light: TerminalColors = { foreground: { r: 30, g: 30, b: 30 }, background: { r: 255, g: 255, b: 255 } }
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

function terminal() {
  const queries: Array<{ timeoutMs: number; onLateReply?: (colors: TerminalColors) => void }> = []
  let changed: (() => void) | undefined
  const release = vi.fn()
  const tui = {
    queryTerminalColors: vi.fn((options) => { queries.push(options); return Promise.resolve({}) }),
    onTerminalColorSchemeChange: vi.fn((listener) => { changed = listener; return release }),
    setTerminalColorSchemeNotifications: vi.fn(),
  }
  return { tui, queries, release, change: () => changed?.() }
}

describe('terminal color adaptation', () => {
  it('retains the screenshot background hue instead of painting ANSI gray', () => {
    const palette = createPalette('auto', screenshot, 'truecolor')
    expect(palette.dialogBand('input')).toBe('\x1b[48;2;65;67;78minput\x1b[49m')
    expect(palette.userBand('prompt')).toContain('48;2;74;76;86')
    expect(palette.dim('hint')).toBe('\x1b[38;2;157;157;162mhint\x1b[39m')
    expect(palette.dim('hint')).not.toContain('\x1b[2m')
  })

  it('detects a light terminal and shades it slightly darker', () => {
    const palette = createPalette('auto', light, 'truecolor')
    expect(palette.dialogBand('input')).toContain('48;2;244;244;244')
    expect(palette.model('model')).toContain('38;2;133;89;22')
    expect(palette.dim('hint')).toContain('38;2;120;120;120')
  })

  it('respects color depth and keeps a fallback for missing reports', () => {
    const palette = createPalette('auto', screenshot, '256color')
    expect(palette.dialogBand('input')).toContain('\x1b[48;5;')
    expect(palette.dim('hint')).toContain('\x1b[38;5;')
    expect(createPalette('auto', {}, 'truecolor').dialogBand('input')).toContain('48;5;236')
    expect(createPalette('plain', screenshot, 'truecolor').dialogBand('input')).toBe('input')
  })

  it('updates previously captured style functions and suppresses duplicate colors', () => {
    const theme = createTerminalTheme('auto', 'truecolor')
    const surface = theme.palette.dialogBand, dim = theme.palette.dim
    const reason = theme.palette.reasoning('max')
    expect(theme.update(screenshot)).toBe(true)
    expect(surface('input')).toContain('48;2;65;67;78')
    expect(dim('hint')).toContain('38;2;157;157;162')
    expect(theme.update(screenshot)).toBe(false)
    expect(theme.update(light)).toBe(true)
    expect(surface('input')).toContain('48;2;244;244;244')
    expect(reason('max')).toContain('38;5;160')
  })

  it('applies a late reply after timeout without blocking input startup', async () => {
    const t = terminal(), theme = createTerminalTheme('auto', 'truecolor'), repaint = vi.fn()
    theme.connect(t.tui as unknown as TUI, repaint)
    expect(t.queries[0]?.timeoutMs).toBe(150)
    await tick()
    expect(repaint).not.toHaveBeenCalled()
    t.queries[0]?.onLateReply?.(screenshot)
    expect(repaint).toHaveBeenCalledTimes(1)
    expect(theme.palette.dialogBand('input')).toContain('48;2;65;67;78')
    t.queries[0]?.onLateReply?.(screenshot)
    expect(repaint).toHaveBeenCalledTimes(1)
    theme.dispose()
    expect(t.release).toHaveBeenCalledTimes(1)
    expect(t.tui.setTerminalColorSchemeNotifications).toHaveBeenLastCalledWith(false)
  })

  it('ignores old replies after a theme change and all replies after disposal', async () => {
    const t = terminal(), theme = createTerminalTheme('auto', 'truecolor'), repaint = vi.fn()
    theme.connect(t.tui as unknown as TUI, repaint)
    t.change()
    await tick()
    t.queries[0]?.onLateReply?.(screenshot)
    expect(repaint).not.toHaveBeenCalled()
    t.queries[1]?.onLateReply?.(light)
    expect(repaint).toHaveBeenCalledTimes(1)
    theme.dispose()
    t.queries[1]?.onLateReply?.(screenshot)
    expect(repaint).toHaveBeenCalledTimes(1)
  })

  it('does not probe terminals in plain mode', () => {
    const t = terminal(), theme = createTerminalTheme('plain', 'truecolor')
    theme.connect(t.tui as unknown as TUI, vi.fn())
    expect(t.tui.queryTerminalColors).not.toHaveBeenCalled()
    expect(theme.update(screenshot)).toBe(false)
  })

  it.each(['context', 'tool'] as const)('repaints cached %s text while preserving its clicked expansion', kind => {
    const theme = createTerminalTheme('auto', 'truecolor')
    const renderer = new TranscriptRenderer({ palette: theme.palette, markdown: markdownTheme(theme.palette), showReasoning: true, maxEntries: 100 })
    const block: TranscriptBlock = kind === 'context'
      ? { kind: 'context', label: 'runtime', text: 'DETAIL SOURCE', seq: 1 }
      : { kind: 'tool', callId: 'call', name: 'bash', args: '{"command":"ls"}', pending: false,
          result: Array.from({ length: 10 }, (_, index) => 'DETAIL SOURCE ' + index).join('\n'), seq: 1 }
    renderer.setNotices([block])
    renderer.container.handleMouse({ type: 'click', button: 'left', x: 1, y: 0, screenX: 1, screenY: 0,
      width: 100, height: 1, shift: false, alt: false, ctrl: false })
    expect(renderer.container.render(100).join('\n')).toContain(kind === 'tool' ? 'DETAIL SOURCE 0' : 'DETAIL SOURCE')
    theme.update(screenshot)
    renderer.refreshPalette()
    const output = renderer.container.render(100).join('\n')
    expect(output).toContain(kind === 'tool' ? 'DETAIL SOURCE 0' : 'DETAIL SOURCE')
    expect(output).toContain('38;2;157;157;162')
    expect(output).toContain('ctrl+o to collapse')
  })
})
