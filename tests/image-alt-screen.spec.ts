import { CURSOR_MARKER, Image, ScrollView, Text, VStack, getCapabilities, setCapabilities, type Component } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimedAltScreen } from '../src/ui/paint-timing.js'

const originalCapabilities = getCapabilities()
const active: TimedAltScreen[] = []
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const imageCount = (output: string) => [...output.matchAll(/\x1b\]1337;File=/gu)].length
const picture = () => new Image(png, 'image/png', { fallbackColor: text => text }, { maxWidthCells: 8, maxHeightCells: 3 })
beforeEach(() => { setCapabilities({ ...originalCapabilities, images: 'iterm2' }) })
afterEach(() => {
  active.splice(0).forEach(tui => tui.stop({ preserveScreen: true }))
  setCapabilities(originalCapabilities)
})

class FakeTerminal {
  columns = 80
  rows = 20
  written = ''
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.written += data }
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

function harness(component: Component = new Text('text', 0, 0)) {
  const terminal = new FakeTerminal()
  const tui = new TimedAltScreen(terminal, false)
  active.push(tui)
  tui.addChild(component)
  tui.start()
  tui.renderNow()
  terminal.written = ''
  return { tui, terminal, paint: (force = false) => { terminal.written = ''; tui.renderNow(force); return terminal.written } }
}

describe('iTerm2 fullscreen images', () => {
  it('keeps the detected image capability while fullscreen is active and restores it on exit', () => {
    const h = harness()
    expect(getCapabilities().images).toBe('iterm2')
    h.tui.stop({ preserveScreen: true })
    active.splice(active.indexOf(h.tui), 1)
    expect(getCapabilities()).toEqual({ ...originalCapabilities, images: 'iterm2' })
  })

  it('paints the complete bounded image after text writes and restores the editor cursor inside the synchronized frame', () => {
    const image = picture()
    const h = harness({ render: width => ['HEADER', ...image.render(width).map(line => '  ' + line), 'EDITOR' + CURSOR_MARKER], invalidate() {} })
    const output = h.paint(true)
    expect(imageCount(output)).toBe(1)
    expect(output).toContain(png)
    expect(output).toContain(';height=3:')
    expect(output).toContain('\x1b7\x1b[2;3H\x1b]1337;File=')
    expect(output.indexOf('EDITOR')).toBeLessThan(output.indexOf('\x1b]1337;File='))
    expect(output.slice(output.indexOf('\x1b]1337;File='))).not.toContain('\x1b[2K')
    expect(output).toMatch(/\x1b8\x1b\[\?2026l$/u)
    expect(output).not.toContain('\x1b[2A')
  })

  it('keeps stable pictures uploaded while ordinary editor and status rows change', () => {
    const image = picture()
    let text = 'EDITOR'
    const h = harness({ render: width => ['HEADER', ...image.render(width), text], invalidate() {} })
    expect(imageCount(h.paint())).toBe(0)
    for (const next of ['EDITOR typing', 'Working (1s)', 'Working (2s)']) {
      text = next
      const output = h.paint()
      expect(output).toContain(next)
      expect(imageCount(output)).toBe(0)
      expect(output).not.toContain('\x1b[2J')
    }
  })

  it('repaints a picture after a text write touches its covered rows', () => {
    const image = picture()
    let background = ''
    const h = harness({ render: width => {
      const rows = image.render(width)
      return ['HEADER', background, ...rows.slice(1), 'EDITOR']
    }, invalidate() {} })
    background = 'covered row changed'
    const output = h.paint()
    expect(imageCount(output)).toBe(1)
    expect(output.indexOf(background)).toBeLessThan(output.indexOf('\x1b]1337;File='))
    expect(output).not.toContain('\x1b[2J')
  })

  it('clears removed pictures before redrawing the remaining image', () => {
    const first = picture(), second = picture()
    let keepFirst = true
    const h = harness({ render: width => ['HEADER', ...(keepFirst ? first.render(width) : []), ...second.render(width), 'EDITOR'], invalidate() {} })
    expect(imageCount(h.paint(true))).toBe(2)
    keepFirst = false
    const removed = h.paint()
    expect(imageCount(removed)).toBe(1)
    expect(removed.indexOf('\x1b[2J')).toBeLessThan(removed.indexOf('\x1b]1337;File='))
    h.tui.clear()
    h.tui.addChild(new Text('NO IMAGES', 0, 0))
    const cleared = h.paint()
    expect(cleared).toContain('\x1b[2J')
    expect(imageCount(cleared)).toBe(0)
  })

  it('moves pictures to their final absolute row after layout and terminal size changes', () => {
    const image = picture()
    let gap = false
    const h = harness({ render: width => ['HEADER', ...(gap ? ['GAP'] : []), ...image.render(width), 'EDITOR'], invalidate() {} })
    gap = true
    expect(h.paint()).toContain('\x1b7\x1b[3;1H\x1b]1337;File=')
    h.terminal.columns = 40
    h.terminal.rows = 14
    const resized = h.paint()
    expect(resized).toContain('\x1b[2J')
    expect(imageCount(resized)).toBe(1)
  })

  it('keeps a fixed image while scrolling the transcript and redraws it at the resized footer position', () => {
    const image = picture()
    const scroll = new ScrollView(new Text(Array.from({ length: 50 }, (_, index) => 'ROW ' + index).join('\n'), 0, 0), { follow: 'end', primary: true })
    const h = harness(new Text('', 0, 0))
    h.tui.setLayoutRoot(new VStack([
      { component: scroll, basis: 0, grow: 1 },
      { component: { render: width => [...image.render(width), 'EDITOR'], invalidate() {} }, basis: 'auto' },
    ]))
    expect(imageCount(h.paint())).toBe(1)
    h.tui.scrollBy(-5)
    expect(imageCount(h.paint())).toBe(0)
    h.terminal.rows = 14
    expect(h.paint()).toContain('\x1b7\x1b[11;1H\x1b]1337;File=')
  })

  it('clears background thumbnails when an image overlay opens and restores them on close', () => {
    const thumbnail = picture(), large = picture()
    let hidden = false
    const h = harness({ render: width => ['HEADER', ...(hidden ? [] : thumbnail.render(width)), 'EDITOR'], invalidate() {} })
    hidden = true
    const overlay = h.tui.showOverlay({ render: width => ['VIEWER', ...large.render(width), 'CLOSE'], invalidate() {} }, { width: 30, anchor: 'center' })
    const opened = h.paint()
    expect(opened).toContain('\x1b[2J')
    expect(opened).toContain('VIEWER')
    expect(imageCount(opened)).toBe(1)
    overlay.hide()
    hidden = false
    const closed = h.paint()
    expect(closed).toContain('\x1b[2J')
    expect(imageCount(closed)).toBe(1)
    expect(h.tui.hasOverlay()).toBe(false)
  })

  it('omits pictures clipped above the viewport and pictures that would advance past its bottom', () => {
    const sequence = '\x1b]1337;File=inline=1;width=6;height=auto;preserveAspectRatio=1:' + png + '\x07'
    const h = harness({ render: () => ['\x1b[4A' + sequence, ...Array.from({ length: 18 }, () => ''), sequence], invalidate() {} })
    expect(imageCount(h.paint(true))).toBe(0)
  })

  it.each([null, 'kitty'] as const)('preserves the native %s capability and output path', protocol => {
    setCapabilities({ ...originalCapabilities, images: protocol })
    const image = picture()
    const h = harness({ render: width => [...image.render(width), 'EDITOR'], invalidate() {} })
    const output = h.paint(true)
    expect(getCapabilities().images).toBe(protocol)
    expect(imageCount(output)).toBe(0)
    expect(output.includes('\x1b_G')).toBe(protocol === 'kitty')
    expect(output).not.toContain('\x1b7')
  })

  it('restores terminal writes when component rendering fails', () => {
    let fail = false
    const h = harness({ render: () => { if (fail) throw new Error('broken component'); return ['EDITOR'] }, invalidate() {} })
    const write = h.terminal.write
    fail = true
    expect(() => h.paint()).toThrow('broken component')
    expect(h.terminal.write).toBe(write)
    fail = false
    expect(h.paint()).not.toBe('')
  })
})
