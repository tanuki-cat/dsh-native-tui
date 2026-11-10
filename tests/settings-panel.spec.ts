import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, onTestFinished } from 'vitest'
import { settingsChoiceSubmenu, showSettingsPanel } from '../src/ui/settings-panel.js'
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
})
