import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, onTestFinished } from 'vitest'
import { settingsChoiceSubmenu, settingsInputSubmenu, showSettingsPanel } from '../src/ui/settings-panel.js'
import { overlayRowLimit } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

describe('settings selection presentation', () => {
  it.each(['dark', 'light', 'plain'] as const)('shares the selected band across values, filtering and submenus in %s', async theme => {
    const palette = createPalette(theme), controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    let panel: Component
    const changes: string[] = []
    const opened = showSettingsPanel({
      requestRender() {},
      showOverlay(value: Component) { panel = value; return { hide() {}, focus() {} } },
    } as never, palette, () => ({
      title: () => 'Settings', hint: 'Esc closes',
      items: [
        { id: 'mode', label: 'Mode', value: 'one', values: ['one', 'two'] },
        { id: 'theme', label: 'Theme', value: 'dark', submenu: (current, done) => settingsChoiceSubmenu(palette, 'Choose theme', [
          { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' },
        ], done, () => done(), undefined, current) },
      ],
      onChange: (id, value) => { changes.push(id + '=' + value); return value },
    }), controller.signal)
    const selected = (width = 60) => panel.render(width).find(row => stripTerminalSequences(row).includes('› '))!
    expect(stripTerminalSequences(selected())).toContain('› Mode')
    if (theme !== 'plain') expect(selected()).toContain('48;5;75;30m')
    panel!.handleInput?.('\r')
    expect(changes).toEqual(['mode=two'])
    panel!.handleInput?.('\x1b[B')
    panel!.handleInput?.('\r')
    expect(stripTerminalSequences(selected())).toContain('› Dark')
    panel!.handleInput?.('\x1b[B')
    expect(stripTerminalSequences(selected(38))).toContain('› Light')
    if (theme !== 'plain') expect(selected(38)).toContain('48;5;75;30m')
    panel!.handleInput?.('\r')
    expect(changes).toEqual(['mode=two', 'theme=light'])
    panel!.handleInput?.('mode')
    expect(stripTerminalSequences(selected())).toContain('› Mode')
    expect(panel!.render(38).every(row => visibleWidth(row) <= 38)).toBe(true)
    if (theme === 'plain') expect(panel!.render(38).join('\n')).not.toMatch(/\x1b\[[0-9;]*m/u)
    controller.abort()
    await opened
  })

  it('preserves hardware cursor marker and fake cursor styling inside InputSubmenu', async () => {
    const palette = createPalette('dark'), controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    let panel: Component
    const opened = showSettingsPanel({
      requestRender() {},
      showOverlay(value: Component) { panel = value; return { hide() {}, focus() {} } },
    } as never, palette, () => ({
      title: () => 'Settings', hint: 'Esc closes',
      items: [{
        id: 'title', label: 'Title', value: 'abc',
        submenu: (current, done) => settingsInputSubmenu({
          palette, title: 'Edit title', placeholder: 'Title', hint: 'Enter saves',
          initialValue: current, onSubmit: done, onCancel: () => done(),
        }),
      }],
      onChange: (_id, value) => value,
    }), controller.signal)
    panel!.handleInput?.('\r')
    const rendered = panel!.render(60)
    const inputRow = rendered.find(row => row.includes(CURSOR_MARKER))
    expect(inputRow).toBeDefined()
    expect(inputRow).toContain(renderFakeCursor(' '))
    expect(inputRow).not.toContain('48;5;75;30m')
    controller.abort()
    await opened
  })
})

describe('short settings terminals', () => {
  it('keeps the last setting inside the overlay height on a 12-row terminal', async () => {
    const palette = createPalette('plain'), controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    let panel: Component
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: 'setting-' + index,
      label: 'Setting ' + index,
      value: 'v' + index,
      values: ['v' + index, 'w' + index],
    }))
    const opened = showSettingsPanel({
      terminal: { rows: 12, columns: 80 },
      requestRender() {},
      showOverlay(value: Component) { panel = value; return { hide() {}, focus() {} } },
    } as never, palette, () => ({
      title: () => 'Settings',
      hint: 'Esc closes',
      items,
      onChange: (_id, value) => value,
    }), controller.signal)
    for (let index = 0; index < 7; index += 1) panel!.handleInput?.('\x1b[B')
    const lines = panel!.render(60)
    const selected = lines.findIndex(row => stripTerminalSequences(row).includes('› '))
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(selected).toBeLessThan(overlayRowLimit(12, 90))
    expect(stripTerminalSequences(lines[selected]!)).toContain('Setting 7')
    expect(lines.every(row => visibleWidth(row) <= 60)).toBe(true)
    controller.abort()
    await opened
  })
})
