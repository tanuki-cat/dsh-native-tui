import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { clipGraphemes, clipTextToWidth } from '../src/ui/grapheme-preview.js'

describe('clipTextToWidth', () => {
  it('bounds a wide CJK preview by display columns, not grapheme count', () => {
    // 200 CJK graphemes occupy 400 columns; a grapheme budget of 200 would wrap
    // the one-line compact thinking preview over several transcript rows.
    const text = '中'.repeat(200)
    const clipped = clipTextToWidth(text, 100)
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(100)
    expect(clipped).not.toContain('\n')
    expect(clipped).toContain('chars omitted')
    expect(clipped.startsWith('中')).toBe(true)
  })

  it('leaves text that already fits untouched', () => {
    expect(clipTextToWidth('短い', 10)).toBe('短い')
    expect(clipTextToWidth('', 10)).toBe('')
  })

  it('falls back to a plain ellipsis when the omission marker cannot fit', () => {
    expect(visibleWidth(clipTextToWidth('中'.repeat(50), 4))).toBeLessThanOrEqual(4)
  })
})

describe('clipGraphemes', () => {
  it('still clips at grapheme boundaries for callers that count clusters', () => {
    expect(clipGraphemes('abcdef', 3)).toBe('abc\n… [3 chars omitted]')
  })
})
