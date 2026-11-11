import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { ScrollToLatest, scrollToEndLabel } from '../src/ui/scroll-indicator.js'
import { createPalette } from '../src/ui/theme.js'

describe('scrollToEndLabel', () => {
  it('names the jump action', () => {
    expect(scrollToEndLabel(createPalette('plain'))).toContain('Back to bottom · esc')
  })

  it('stays unstyled for the plain palette', () => {
    expect(scrollToEndLabel(createPalette('plain'))).toBe('↓ Back to bottom · esc')
  })

  it.each(['dark', 'light'] as const)('uses the accent foreground in %s mode', theme => {
    const palette = createPalette(theme)
    expect(scrollToEndLabel(palette)).toBe(palette.accent('↓ Back to bottom · esc'))
  })

  it.each(['plain', 'dark', 'light'] as const)('reserves one row and stays within narrow %s viewports', theme => {
    let following = false
    const row = new ScrollToLatest(createPalette(theme), () => following, () => {})
    for (const width of [0, 1, 2, 8, 20, 80]) {
      expect(row.render(width)).toHaveLength(1)
      expect(visibleWidth(row.render(width)[0]!)).toBeLessThanOrEqual(width)
    }
    expect(stripTerminalSequences(row.render(40)[0]!)).toBe(' '.repeat(8) + ' ↓ Back to bottom · esc ')
    following = true
    expect(row.render(40)).toEqual([''])
  })

  it.each(['dark', 'light'] as const)('limits the %s background to the button', theme => {
    const palette = createPalette(theme)
    const row = new ScrollToLatest(palette, () => false, () => {})
    expect(row.render(40)).toEqual([' '.repeat(8) + palette.dialogBand(' ' + palette.accent('↓ Back to bottom · esc') + ' ')])
  })
})
