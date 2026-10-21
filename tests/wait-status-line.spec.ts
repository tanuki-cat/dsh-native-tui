import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/ui/theme.js'
import { WaitStatusLine, waitingText } from '../src/ui/waiting.js'

const palette = createPalette('plain')

describe('WaitStatusLine', () => {
  it.each([1, 12, 80])('keeps one row at width %i through wait, retry, tool and idle transitions', width => {
    const line = new WaitStatusLine(palette)
    const labels = [
      '',
      waitingText(0, undefined, 2_000),
      waitingText(0, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 4_000),
      waitingText(0, undefined, 6_000, { kind: 'tool', name: 'a-long-tool-name-'.repeat(20) }),
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

  it('shows the wait label and reuses its leaf until the label changes', () => {
    const line = new WaitStatusLine(palette)
    line.setText('waiting for response · 2s')
    expect(line.render(80)[0]).toContain('⟳ waiting for response · 2s')
    const before = line.children[0]
    line.setText('waiting for response · 2s')
    expect(line.children[0]).toBe(before)
    line.setText('')
    expect(line.children).toHaveLength(1)
    expect(line.render(80)[0]?.trim()).toBe('')
  })
})
