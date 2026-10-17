import { describe, expect, it } from 'vitest'
import { collectDeliverables, formatDeliverables } from '../src/runtime/deliverables.js'

describe('collectDeliverables', () => {
  it('keeps the latest description and turn per path', () => {
    const rows = collectDeliverables([
      { turn: 1, files: [{ path: '/tmp/a.md', description: 'old' }] },
      { turn: 2, files: [{ path: '/tmp/a.md', description: 'new' }, { path: '/tmp/b.md' }] },
    ])
    expect(rows).toEqual([
      { path: '/tmp/a.md', description: 'new', turn: 2 },
      { path: '/tmp/b.md', turn: 2 },
    ])
  })
})

describe('formatDeliverables', () => {
  it('lists latest declarations and de-duplicates paths', () => {
    const text = formatDeliverables([
      { turn: 1, files: [{ path: '/tmp/report.md', description: 'report' }] },
      { turn: 2, files: [{ path: '/tmp/report.md', description: 'updated report' }, { path: '/tmp/slides.pptx' }] },
    ])
    expect(text).toContain('Deliverables · 2 file(s)')
    expect(text).toContain('/tmp/report.md — updated report  (turn 2)')
    expect(text).toContain('/tmp/slides.pptx  (turn 2)')
    expect(text).not.toContain('turn 1')
  })

  it('handles an empty list and caps rows', () => {
    expect(formatDeliverables([])).toBe('No presented deliverables.')
    const events = [{ turn: 1, files: Array.from({ length: 5 }, (_, index) => ({ path: '/tmp/f' + String(index) })) }]
    const text = formatDeliverables(events, 2)
    expect(text).toContain('3 more file(s)')
  })
})