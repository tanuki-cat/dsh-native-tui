import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { showMarkdownPreview, showMultilineInput, showTextPager } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'
import { createTerminalTheme } from '../src/ui/terminal-theme.js'

function host(rows = 40) {
  let component: Component
  let listener: ((data: string) => unknown) | undefined
  const controller = new AbortController(), hide = vi.fn(), release = vi.fn()
  const tui = { terminal: { rows }, requestRender() {},
    showOverlay(value: Component) { component = value; return { hide, focus() {} } },
    addInputListener(value: typeof listener) { listener = value; return () => { release(); listener = undefined } },
  }
  onTestFinished(() => { controller.abort() })
  return { tui: tui as never, controller, hide, release,
    render: (width = 80) => component.render(width),
    key: (data: string) => { if (listener !== undefined) listener(data); else component.handleInput?.(data) },
  }
}

describe('preview repainting', () => {
  it('recolors an open Markdown preview after late replies and a later scheme change', async () => {
    const h = host(), theme = createTerminalTheme('auto', 'truecolor')
    const opened = showMarkdownPreview(h.tui, theme.palette, 'Code', '`INLINE`', h.controller.signal)
    expect(h.render().join('\n')).toContain('\x1b[38;5;117mINLINE')
    theme.update({ background: { r: 40, g: 42, b: 54 }, foreground: { r: 235, g: 235, b: 235 } })
    const late = h.render().join('\n')
    expect(late).toContain('48;2;65;67;78m')
    expect(late).toContain('38;2;157;157;162m')
    theme.update({ background: { r: 255, g: 255, b: 255 }, foreground: { r: 20, g: 20, b: 20 } })
    const light = h.render().join('\n')
    expect(light).toContain('\x1b[38;5;25mINLINE')
    expect(light).not.toContain('\x1b[38;5;117m')
    expect(light).not.toContain('38;2;157;157;162m')
    h.key('\x1b')
    await opened
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.release).toHaveBeenCalledOnce()
  })

  it('reflows Markdown at the overlay width when resized', async () => {
    const h = host(80)
    const opened = showMarkdownPreview(h.tui, createPalette('plain'), 'Text', 'alpha beta gamma delta epsilon zeta eta theta iota kappa', h.controller.signal)
    const wide = h.render(80), narrow = h.render(28)
    expect(narrow.length).toBeGreaterThan(wide.length)
    expect(narrow.every(line => visibleWidth(line) <= 28)).toBe(true)
    expect(narrow.join('\n')).toContain('iota kappa')
    h.controller.abort()
    await opened
  })

  it('pages within terminal height and retains a valid offset after resizing', async () => {
    const h = host(10)
    const opened = showTextPager(h.tui, createPalette('plain'), 'Log', Array.from({ length: 20 }, (_, i) => 'ROW_' + i).join('\n'), h.controller.signal)
    expect(h.render().length).toBeLessThanOrEqual(8)
    h.key('\x1b[6~')
    expect(h.render().join('\n')).toContain('lines 5–8 / 20')
    h.key('\x1b[A')
    expect(h.render(40).join('\n')).toContain('ROW_3')
    h.key('\x1b[5~')
    expect(h.render().join('\n')).toContain('lines 1–4 / 20')
    h.controller.abort()
    await opened
    expect(h.release).toHaveBeenCalledOnce()
  })

  it('keeps external text unstyled and strips terminal instructions', async () => {
    const h = host()
    const opened = showTextPager(h.tui, createPalette('plain'), '\x1b]52;c;BAD\x07Title', '\x1b[31mCONTENT\x1b[0m\x1b[2J', h.controller.signal)
    const output = h.render().join('\n')
    expect(output).toContain('CONTENT')
    expect(output).not.toContain('\x1b')
    expect(output).not.toContain('BAD')
    h.key('\x1b')
    await opened
  })
})

describe('multiline dialog editor', () => {
  it.each(['dark', 'light', 'plain'] as const)('uses padded prompt rows and preserves native editing in %s', async theme => {
    const h = host(), palette = createPalette(theme)
    const opened = showMultilineInput(h.tui, palette, 'Edit JSON', '{}', 'Enter saves', h.controller.signal)
    const rows = h.render(50), plain = rows.map(stripTerminalSequences)
    expect(plain.filter(row => row.includes('─'))).toHaveLength(2)
    expect(plain.some(row => row.includes('› {}'))).toBe(true)
    expect(rows.filter(row => row.includes(CURSOR_MARKER))).toHaveLength(1)
    expect(rows.every(row => visibleWidth(row) <= 50)).toBe(true)
    h.key('\x05')
    h.key('\x0a')
    h.key('NEXT')
    h.key('\r')
    await expect(opened).resolves.toBe('{}\nNEXT')
  })

  it('cancels edited multiline text with Escape', async () => {
    const h = host()
    const opened = showMultilineInput(h.tui, createPalette('plain'), 'Edit', 'old', 'Enter saves', h.controller.signal)
    h.key('new')
    h.key('\x1b')
    await expect(opened).resolves.toBeUndefined()
    expect(h.hide).toHaveBeenCalledOnce()
  })
})
