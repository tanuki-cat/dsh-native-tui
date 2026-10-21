import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/ui/theme.js'
import { WaitStatusLine, waitingText } from '../src/ui/waiting.js'

const palette = createPalette('plain')

describe('waitingText', () => {
  it('reports working independently of whether content has arrived', () => {
    expect(waitingText(1_000, undefined, 1_000)).toBe('working · 0s')
    expect(waitingText(1_000, undefined, 4_400)).toBe('working · 3s')
  })

  it('reports automatic retry instead of ordinary working', () => {
    expect(waitingText(1_000, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 6_000))
      .toBe('retry 2/5 after TRANSPORT (automatic) · 5s')
  })

  it('does not count backwards when the clock jumps', () => {
    expect(waitingText(5_000, undefined, 1_000)).toBe('working · 0s')
  })
})

describe('WaitStatusLine', () => {
  it.each([1, 12, 80])('keeps one row at width %i through working, retry and idle transitions', width => {
    const line = new WaitStatusLine(palette)
    const labels = [
      '',
      waitingText(0, undefined, 2_000),
      waitingText(0, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 4_000),
      'retry 2/5 after ' + 'LONG_FAILURE_CODE_'.repeat(20),
      '',
    ]
    for (const text of labels) {
      line.setText(text)
      const rows = line.render(width)
      expect(rows).toHaveLength(1)
      expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width)
    }
    expect(line.render(width)[0]?.trim()).toBe('')
  })

  it('shows execution status and reuses its leaf until the label changes', () => {
    const line = new WaitStatusLine(palette)
    line.setText('working · 2s')
    expect(line.render(80)[0]).toContain('⟳ working · 2s')
    const before = line.children[0]
    line.setText('working · 2s')
    expect(line.children[0]).toBe(before)
    line.setText('')
    expect(line.children).toHaveLength(1)
    expect(line.render(80)[0]?.trim()).toBe('')
  })
})
