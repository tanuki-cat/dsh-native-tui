import { describe, expect, it } from 'vitest'
import { createStatusRows } from '../src/ui/status-rows.js'
import type { StatusSegment } from '../src/ui/status-bar.js'

/** A chrome row that records every write it received. */
function target() {
  const written: string[] = []
  return { written, row: {
    setText: (text: string) => { written.push(text) },
    setSegments: (segments: readonly StatusSegment[]) => { written.push(segments.map(segment => segment.text).join(' · ')) },
  } }
}

describe('deduplicated status rows', () => {
  it('writes a row the first time and skips an identical repaint', () => {
    const header = target()
    const status = target()
    const footer = target()
    const rows = createStatusRows({ header: header.row, status: status.row, footer: footer.row })

    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setSegments([{ text: 'S' }])
    rows.rows.footer.setSegments([{ text: 'F' }])
    expect(rows.changed).toBe(true)
    expect(header.written).toEqual(['H'])
    expect(status.written).toEqual(['S'])
    expect(footer.written).toEqual(['F'])

    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setSegments([{ text: 'S' }])
    rows.rows.footer.setSegments([{ text: 'F' }])
    expect(rows.changed).toBe(false)
    expect(header.written).toEqual(['H'])
    expect(status.written).toEqual(['S'])
    expect(footer.written).toEqual(['F'])
  })

  it('writes only the row that changed', () => {
    const header = target()
    const status = target()
    const footer = target()
    const rows = createStatusRows({ header: header.row, status: status.row, footer: footer.row })

    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setSegments([{ text: 'S' }])
    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setSegments([{ text: 'S2' }])

    expect(rows.changed).toBe(true)
    expect(header.written).toEqual(['H'])
    expect(status.written).toEqual(['S', 'S2'])
    expect(footer.written).toEqual([])
  })

  it('treats the first write of an empty row as a change', () => {
    // The idle footer starts empty; the first paint must still reach the screen.
    const footer = target()
    const rows = createStatusRows({ header: target().row, status: target().row, footer: footer.row })
    rows.reset()
    rows.rows.footer.setSegments([{ text: '' }])
    expect(rows.changed).toBe(true)
    expect(footer.written).toEqual([''])
    rows.reset()
    rows.rows.footer.setSegments([{ text: '' }])
    expect(rows.changed).toBe(false)
    expect(footer.written).toEqual([''])
  })

  it('repaints when the compact label or priority changes without changing the full label', () => {
    const status = target()
    const rows = createStatusRows({ header: target().row, status: status.row, footer: target().row })
    rows.rows.status.setSegments([{ text: 'model', compact: 'm', priority: 2 }])
    rows.reset()
    rows.rows.status.setSegments([{ text: 'model', compact: 'm', priority: 2 }])
    expect(rows.changed).toBe(false)
    rows.rows.status.setSegments([{ text: 'model', compact: 'new', priority: 2 }])
    expect(rows.changed).toBe(true)
    rows.reset()
    rows.rows.status.setSegments([{ text: 'model', compact: 'new', priority: 1 }])
    expect(rows.changed).toBe(true)
    expect(status.written).toHaveLength(3)
  })

  it('keeps the last written text across resets', () => {
    // A reset clears the flag, never the memory of what the screen shows.
    const header = target()
    const rows = createStatusRows({ header: header.row, status: target().row, footer: target().row })
    rows.reset()
    rows.rows.header.setText('H')
    rows.reset()
    rows.rows.header.setText('H')
    expect(header.written).toEqual(['H'])
    expect(rows.changed).toBe(false)
  })
})
