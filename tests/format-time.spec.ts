import { describe, expect, it } from 'vitest'
import { formatLocalTimestamp } from '../src/ui/format-time.js'

describe('formatLocalTimestamp', () => {
  it('renders the wall clock of the zone', () => {
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 47, 48, 250), 'Asia/Shanghai'))
      .toBe('2026-10-22 08:47:48')
  })

  it('renders UTC in the same shape, without a Z suffix', () => {
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 47, 48), 'UTC'))
      .toBe('2026-10-22 00:47:48')
  })

  it('renders negative offsets on the local date', () => {
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 47, 48), 'America/New_York'))
      .toBe('2026-10-21 20:47:48')
  })

  it('follows the daylight-saving transition of the zone', () => {
    expect(formatLocalTimestamp(Date.UTC(2026, 2, 8, 6, 59), 'America/New_York'))
      .toBe('2026-03-08 01:59:00')
    expect(formatLocalTimestamp(Date.UTC(2026, 2, 8, 7, 0), 'America/New_York'))
      .toBe('2026-03-08 03:00:00')
  })

  it('renders half-hour offsets and zones that cross the date line', () => {
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 0), 'Asia/Kolkata'))
      .toBe('2026-10-22 05:30:00')
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 0), 'Pacific/Kiritimati'))
      .toBe('2026-10-22 14:00:00')
    expect(formatLocalTimestamp(Date.UTC(2026, 9, 22, 0, 0), 'Pacific/Midway'))
      .toBe('2026-10-21 13:00:00')
  })

  it('defaults to the host zone', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const ms = Date.UTC(2026, 9, 22, 0, 47, 48)
    expect(formatLocalTimestamp(ms)).toBe(formatLocalTimestamp(ms, zone))
    expect(formatLocalTimestamp(ms)).toHaveLength(19)
  })
})
