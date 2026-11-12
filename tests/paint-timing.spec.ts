import { ScrollView, Text, VStack } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { TimedAltScreen, TimedMainScreen } from '../src/ui/paint-timing.js'
import { StreamPacer } from '../src/ui/stream-pacing.js'

class FakeTerminal {
  columns = 80
  rows = 20
  onWrite = (): void => {}
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void { this.onWrite() }
  get kittyProtocolActive(): boolean { return false }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

describe('complete paint timing', () => {
  it.each(['main', 'fullscreen'] as const)('includes component layout and terminal writes in %s', mode => {
    const terminal = new FakeTerminal()
    const tui = mode === 'main' ? new TimedMainScreen(terminal, false) : new TimedAltScreen(terminal, false)
    let clock = 0
    let content = 'first'
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const pacer = new StreamPacer()
    const measured: number[] = []
    const component = { render: () => { clock += 13; return [content] }, invalidate: () => {} }
    if (tui instanceof TimedAltScreen) {
      tui.setLayoutRoot(new VStack([
        { component: new ScrollView(component, { follow: 'end', primary: true }), basis: 0, grow: 1 },
        { component: new Text('editor', 0, 0), basis: 'auto' },
      ]))
    } else tui.addChild(component)
    tui.onPaint = ms => { measured.push(ms); pacer.paint(ms) }
    try {
      tui.start()
      tui.renderNow()
      measured.length = 0
      terminal.onWrite = () => { clock += 7 }
      // Preparation finishes before paint; no future timer needs to be late.
      pacer.prepare(2)
      content = 'second'
      tui.renderNow()
      expect(measured).toHaveLength(1)
      expect(measured[0]).toBeGreaterThanOrEqual(20)
      expect(pacer.interval).toBe((measured[0]! + 2) * 2)
      const interval = pacer.interval
      content = 'chrome-only change'
      tui.renderNow()
      expect(pacer.interval).toBe(interval)
    } finally {
      tui.stop()
      now.mockRestore()
    }
  })
})
