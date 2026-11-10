import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/ui/theme.js'
import { createTerminalTheme } from '../src/ui/terminal-theme.js'
import { TurnStatus, WaitStatusLine, waitingText } from '../src/ui/waiting.js'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'

const palette = createPalette('plain')

describe('waitingText', () => {
  it('reports working independently of whether content has arrived', () => {
    expect(waitingText(1_000, undefined, 1_000)).toBe('Working (0s · esc to interrupt)')
    expect(waitingText(1_000, undefined, 4_400)).toBe('Working (3s · esc to interrupt)')
  })

  it('reports automatic retry instead of ordinary working', () => {
    expect(waitingText(1_000, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 6_000))
      .toBe('Retrying 2/5 (5s · TRANSPORT · automatic · esc to interrupt)')
  })

  it('does not count backwards when the clock jumps', () => {
    expect(waitingText(5_000, undefined, 1_000)).toBe('Working (0s · esc to interrupt)')
  })

  it.each([
    [0, '0s'],
    [9_000, '9s'],
    [59_499, '59s'],
    [59_500, '1m 0s'],
    [60_000, '1m 0s'],
    [65_000, '1m 5s'],
    [213_000, '3m 33s'],
    [3_599_499, '59m 59s'],
    [3_599_500, '1h 0m 0s'],
    [3_600_000, '1h 0m 0s'],
    [3_601_000, '1h 0m 1s'],
    [3_723_000, '1h 2m 3s'],
    [90_061_000, '25h 1m 1s'],
    [360_000_000, '100h 0m 0s'],
  ])('formats %i elapsed milliseconds consistently for working and retry', (elapsed, expected) => {
    const since = 123_456_789
    expect(waitingText(since, undefined, since + elapsed)).toBe('Working (' + expected + ' · esc to interrupt)')
    expect(waitingText(since, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, since + elapsed))
      .toBe('Retrying 2/5 (' + expected + ' · TRANSPORT · automatic · esc to interrupt)')
  })
})

describe('WaitStatusLine', () => {
  it.each([1, 12, 80])('keeps one row at width %i through working, retry and idle transitions', width => {
    const line = new WaitStatusLine(palette)
    const labels = [
      '',
      waitingText(0, undefined, 2_000),
      waitingText(0, undefined, 65_000),
      waitingText(0, undefined, 360_000_000),
      waitingText(0, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 4_000),
      'Retrying 2/5 (4s · ' + 'LONG_FAILURE_CODE_'.repeat(20) + ' · automatic)',
      'Worked for 2m 22s · 10:49',
      'Failed after 3s · 10:49',
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
    line.setText('Working (2s · esc to interrupt)')
    expect(line.render(80)[0]).toContain('• Working (2s · esc to interrupt)')
    const before = line.children[0]
    line.setText('Working (2s · esc to interrupt)')
    expect(line.children[0]).toBe(before)
    line.setText('')
    expect(line.children).toHaveLength(1)
    expect(line.render(80)[0]?.trim()).toBe('')
  })

  it('uses a quiet marker, warns for retries, and sanitizes terminal controls', () => {
    const palette = createPalette('dark'), line = new WaitStatusLine(palette)
    line.setText(waitingText(0, undefined, 142_000))
    expect(line.render(120)[0]).toContain(palette.dim('• '))
    expect(line.render(120)[0]).not.toContain('⟳')
    line.setText(waitingText(0, { retry: 1, maxRetries: 3, code: 'safe\x1b]52;c;bad\x07' }, 4_000))
    expect(line.render(120)[0]).toContain(palette.warning('Retrying 1/3'))
    expect(line.render(120)[0]).not.toContain('\x1b]52;')
  })

  it('recolors a completed receipt after a terminal theme reply without recreating its leaf', () => {
    const theme = createTerminalTheme('auto', 'truecolor'), line = new WaitStatusLine(theme.palette)
    line.setText('Worked for 2m 22s · 10:49')
    const leaf = line.children[0]
    expect(line.render(100)[0]).toContain('\x1b[2m')
    theme.update({ foreground: { r: 235, g: 235, b: 235 }, background: { r: 40, g: 42, b: 54 } })
    expect(line.render(100)[0]).toContain('38;2;157;157;162')
    expect(stripTerminalSequences(line.render(100)[0]!)).toContain('Worked for 2m 22s · 10:49')
    expect(line.children[0]).toBe(leaf)
  })
})

describe('TurnStatus', () => {
  const ended = Date.UTC(2026, 10, 10, 2, 49)

  it('keeps one elapsed clock through attempts, retries and resumed content', () => {
    const status = new TurnStatus()
    status.begin(undefined, 1_000)
    status.begin({ retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 4_000)
    expect(status.text(6_000)).toBe('Retrying 2/5 (5s · TRANSPORT · automatic · esc to interrupt)')
    status.resume()
    expect(status.text(7_000)).toBe('Working (6s · esc to interrupt)')
    status.begin(undefined, 8_000)
    expect(status.text(9_000)).toBe('Working (8s · esc to interrupt)')
  })

  it.each([
    ['completed', 'Worked for'], ['aborted', 'Cancelled after'], ['error', 'Failed after'],
    ['blocked', 'Blocked after'], ['max-tokens', 'Stopped at token limit after'],
    ['interrupted', 'Interrupted after'], ['forked', 'Forked after'],
  ] as const)('shows an accurate %s receipt and keeps it stable after settlement', (kind, label) => {
    const status = new TurnStatus()
    status.begin(undefined, ended - 142_000)
    status.finish({ kind } as TurnEndReason, ended, 'Asia/Shanghai')
    expect(status.text(ended)).toBe(label + ' 2m 22s · 10:49')
    status.finish({ kind: 'completed' }, ended + 60_000, 'Asia/Shanghai')
    expect(status.text(ended + 300_000)).toBe(label + ' 2m 22s · 10:49')
  })

  it('does not invent a receipt without a live turn and clears it for new work or another session', () => {
    const status = new TurnStatus()
    status.finish({ kind: 'completed' }, ended, 'Asia/Shanghai')
    expect(status.text()).toBe('')
    status.begin(undefined, ended - 1000)
    status.finish({ kind: 'completed' }, ended, 'Asia/Shanghai')
    expect(status.text()).toContain('Worked for 1s')
    status.begin(undefined, ended + 1000)
    expect(status.text(ended + 2000)).toBe('Working (1s · esc to interrupt)')
    status.clear()
    expect(status.text()).toBe('')
  })

  it('clamps clock rollback while preserving the local finish clock', () => {
    const status = new TurnStatus()
    status.begin(undefined, ended + 60_000)
    status.finish({ kind: 'completed' }, ended, 'Asia/Shanghai')
    expect(status.text()).toBe('Worked for 0s · 10:49')
  })
})
