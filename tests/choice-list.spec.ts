import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ChoiceList } from '../src/ui/choice-list.js'
import { createPalette } from '../src/ui/theme.js'
import { createTerminalTheme } from '../src/ui/terminal-theme.js'

describe('choice list presentation', () => {
  it.each(['dark', 'light', 'plain'] as const)('paints selected rows and semantic badges safely in %s', theme => {
    const palette = createPalette(theme)
    const list = new ChoiceList([
      { value: 'first', label: 'First' },
      { value: 'second', label: 'Second\x1b[31m', badge: { text: 'New\x1b]52;c;BAD\x07', tone: 'warning' } },
    ], 2, palette)
    const rows = list.render(60)
    expect(stripTerminalSequences(rows[0]!)).toBe('› First' + ' '.repeat(53))
    expect(rows[0]).toBe(palette.autocompleteSelection(stripTerminalSequences(rows[0]!)))
    expect(rows[1]).toContain(palette.warning('[New]'))
    expect(rows.join('\n')).not.toContain('BAD')
    expect(rows.join('\n')).not.toContain('\x1b[31m')
    if (theme === 'plain') expect(rows.join('\n')).not.toContain('\x1b')
    const onSelect = vi.fn()
    list.onSelect = onSelect
    list.handleInput('\x1b[B')
    const selected = list.render(24)
    expect(stripTerminalSequences(selected[1]!)).toContain('› Second [New]')
    expect(selected[1]).toBe(palette.autocompleteSelection(stripTerminalSequences(selected[1]!)))
    expect(selected.every(row => visibleWidth(row) <= 24)).toBe(true)
    list.handleInput('\r')
    expect(onSelect.mock.calls[0]?.[0].value).toBe('second')
  })

  it('updates unselected badge colors at paint time without resetting navigation', () => {
    const theme = createTerminalTheme('auto', 'truecolor')
    const list = new ChoiceList([
      { value: 'one', label: 'One', badge: { text: 'Info', tone: 'info' } },
      { value: 'two', label: 'Two' },
    ], 2, theme.palette)
    list.setSelectedIndex(1)
    expect(list.render(60)[0]).toContain('\x1b[38;5;117m[Info]')
    theme.update({ background: { r: 255, g: 255, b: 255 } })
    expect(list.render(60)[0]).toContain('\x1b[38;5;25m[Info]')
    expect(list.getSelectedItem()?.value).toBe('two')
    list.setFilter('one')
    expect(stripTerminalSequences(list.render(60)[0]!)).toContain('› One [Info]')
  })
})
