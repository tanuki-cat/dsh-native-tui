import { describe, expect, it, vi } from 'vitest'
import { createStatusRows } from '../src/ui/status-rows.js'

/** A chrome row that records every write it received. */
function target() {
  const written: string[] = []
  return { written, row: { setText: (text: string) => { written.push(text) } } }
}

describe('deduplicated status rows', () => {
  it('writes a row the first time and skips an identical repaint', () => {
    const header = target()
    const status = target()
    const footer = target()
    const rows = createStatusRows({ header: header.row, status: status.row, footer: footer.row })

    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setText('S')
    rows.rows.footer.setText('F')
    expect(rows.changed).toBe(true)
    expect(header.written).toEqual(['H'])
    expect(status.written).toEqual(['S'])
    expect(footer.written).toEqual(['F'])

    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setText('S')
    rows.rows.footer.setText('F')
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
    rows.rows.status.setText('S')
    rows.reset()
    rows.rows.header.setText('H')
    rows.rows.status.setText('S2')

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
    rows.rows.footer.setText('')
    expect(rows.changed).toBe(true)
    expect(footer.written).toEqual([''])
    rows.reset()
    rows.rows.footer.setText('')
    expect(rows.changed).toBe(false)
    expect(footer.written).toEqual([''])
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
