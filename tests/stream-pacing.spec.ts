import { describe, expect, it } from 'vitest'
import { StreamPacer } from '../src/ui/stream-pacing.js'

describe('StreamPacer', () => {
  it('budgets actual paint even when the next chunk arrives after that paint', () => {
    const pacer = new StreamPacer()
    pacer.prepare(2)
    expect(pacer.interval).toBe(33)
    expect(pacer.paint(40)).toBe(42)
    expect(pacer.interval).toBe(84)
    pacer.prepare(1)
    pacer.paint(40)
    expect(pacer.interval).toBe(82)
  })

  it('counts coalesced rebuilds once and ignores unrelated chrome paints', () => {
    const pacer = new StreamPacer()
    pacer.prepare(4)
    pacer.prepare(6)
    expect(pacer.paint(40)).toBe(50)
    expect(pacer.interval).toBe(100)
    expect(pacer.paint(300)).toBeUndefined()
    expect(pacer.interval).toBe(100)
  })

  it('excludes a cold rebuild and its complete paint from steady pacing', () => {
    const pacer = new StreamPacer()
    pacer.prepare(5)
    pacer.paint(95)
    expect(pacer.interval).toBe(200)
    pacer.prepare(500, true)
    pacer.prepare(1)
    pacer.paint(300)
    expect(pacer.interval).toBe(33)
    pacer.prepare(1)
    pacer.paint(40)
    expect(pacer.interval).toBe(82)
  })

  it('bounds expensive paints and recovers gradually on cheap frames', () => {
    const pacer = new StreamPacer()
    pacer.prepare(1)
    pacer.paint(600)
    expect(pacer.interval).toBe(500)
    pacer.prepare(1)
    pacer.paint(1)
    expect(pacer.interval).toBe(375)
  })

  it('keeps the first paint cold after prewarming has made the next rebuild cheap', () => {
    const pacer = new StreamPacer()
    pacer.prepare(0, true)
    pacer.prepare(1)
    pacer.paint(300)
    expect(pacer.interval).toBe(33)
    pacer.prepare(1)
    pacer.paint(40)
    expect(pacer.interval).toBe(82)
  })

  it('discards pending cost and interval when the session or display resets', () => {
    const pacer = new StreamPacer()
    pacer.prepare(100)
    pacer.paint(100)
    pacer.prepare(500, true)
    pacer.reset()
    expect(pacer.paint(500)).toBeUndefined()
    expect(pacer.interval).toBe(33)
    pacer.prepare(2)
    pacer.paint(40)
    expect(pacer.interval).toBe(84)
  })

  it('ignores unusable or negative durations', () => {
    const pacer = new StreamPacer()
    pacer.prepare(Number.NaN)
    expect(pacer.paint(-1)).toBe(0)
    pacer.prepare(-5)
    expect(pacer.paint(Number.POSITIVE_INFINITY)).toBe(0)
    expect(pacer.interval).toBe(33)
  })
})
