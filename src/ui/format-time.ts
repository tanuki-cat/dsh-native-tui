/**
 * Human-facing timestamps for notices.
 *
 * Lists such as `/sessions` and `/agents` are read next to the user's own
 * clock, so an ISO `Z` string reads hours off outside UTC. Exports, manifests
 * and event payloads keep UTC ISO; only notices use this.
 *
 * @module dsh-native-tui/ui/format-time
 */

/** Wall-clock fields of one instant in a zone. */
interface Clock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/**
 * Read the wall-clock fields of `date` in `timeZone`, avoiding locale strings
 * so the result does not depend on `LANG`.
 * @param date - the instant to read.
 * @param timeZone - IANA zone; `undefined` means the host zone.
 * @returns the wall-clock fields.
 */
function wallClock(date: Date, timeZone: string | undefined): Clock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** Zero-pad a non-negative integer for column-aligned output. */
function pad(value: number, width = 2): string {
  return String(Math.trunc(value)).padStart(width, '0')
}

/**
 * Format an epoch timestamp as wall-clock time in the host zone.
 *
 * The fixed `YYYY-MM-DD HH:mm:ss` shape keeps notice columns aligned and reads
 * like the clock next to the terminal; seconds are enough, so milliseconds are
 * dropped. The zone comes from `Intl`, so DST and non-hour offsets stay correct.
 *
 * @param ms - epoch milliseconds.
 * @param timeZone - IANA zone; defaults to the host zone.
 * @returns `YYYY-MM-DD HH:mm:ss`.
 */
export function formatLocalTimestamp(ms: number, timeZone?: string): string {
  const clock = wallClock(new Date(ms), timeZone)
  return pad(clock.year, 4) + '-' + pad(clock.month) + '-' + pad(clock.day)
    + ' ' + pad(clock.hour) + ':' + pad(clock.minute) + ':' + pad(clock.second)
}
