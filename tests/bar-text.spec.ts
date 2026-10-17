import { describe, expect, it } from 'vitest'
import { BarText } from '../src/ui/bar-text.js'

describe('BarText', () => {
  it('keeps the bar on every wrapped line', () => {
    const lines = new BarText('one two three four five', '│ ').render(10)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => line.startsWith('│ '))).toBe(true)
  })

  it('does not render empty content', () => {
    expect(new BarText('', '│ ').render(20)).toEqual([])
  })
})
