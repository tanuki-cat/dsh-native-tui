import { describe, expect, it } from 'vitest'
import { scrollToEndLabel } from '../src/ui/scroll-indicator.js'
import { createPalette } from '../src/ui/theme.js'

describe('scrollToEndLabel', () => {
  it('names the jump action', () => {
    expect(scrollToEndLabel(createPalette('plain'))).toContain('jump to latest')
  })

  it('stays unstyled for the plain palette', () => {
    expect(scrollToEndLabel(createPalette('plain'))).toBe('\u2193 jump to latest')
  })

  it('paints the arrow and the words with their own palette roles', () => {
    const label = scrollToEndLabel(createPalette('dark'))
    expect(label).toBe(createPalette('dark').accent('\u2193 ') + createPalette('dark').dim('jump to latest'))
    expect(label).toContain('\u001B[')
  })
})
