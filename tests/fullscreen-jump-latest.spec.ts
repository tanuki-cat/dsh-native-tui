import { Box, ScrollView, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ScrollToLatest } from '../src/ui/scroll-indicator.js'
import { createPalette } from '../src/ui/theme.js'

/**
 * The fullscreen viewport owns its scroll offset, so a reader who scrolled up
 * gets back to the tail through the centered button above the composer.
 * Drive a real layout so mouse coordinates and output following are verified
 * together with the final rendered position.
 */

class FakeTerminal {
  output = ''
  columns = 40
  rows = 10
  kittyProtocolActive = false
  onInput: ((data: string) => void) | undefined
  start(onInput: (data: string) => void): void { this.onInput = onInput }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data }
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

const NL = String.fromCharCode(10)
const LABEL = 'Back to bottom'

function strip(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '')
}

/** One alt-screen viewport filled past its own height, following the tail. */
function openViewport() {
  const terminal = new FakeTerminal()
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
  })
  onTestFinished(() => { tui.stop() })
  const rows = Array.from({ length: 40 }, (_, index) => 'row' + String(index).padStart(3, '0'))
  const document = new Box(0, 0)
  document.addChild(new Text(rows.join(NL), 0, 0))
  tui.setLayoutRoot(new VStack([
    { component: new ScrollView(document, { follow: 'end', primary: true }), basis: 0, grow: 1, minSize: 1 },
    { component: new ScrollToLatest(createPalette('plain'), () => tui.isFollowingOutput, () => { tui.scrollToBottom() }), basis: 'auto' },
    { component: new Text('EDITOR', 0, 0), basis: 'auto' },
  ]))
  tui.start()
  /**
   * Render one frame and return the screen as rows of exactly the terminal
   * width. Alt-screen schedules its own frame, and `scrollBy` is its public
   * way to ask for one, so a zero-line scroll only requests the repaint.
   */
  const frame = async (): Promise<string[]> => {
    tui.scrollBy(0)
    await new Promise(resolve => setTimeout(resolve, 80))
    return tui.getScreenLines().map(strip)
  }
  return { terminal, tui, rows, frame }
}

describe('fullscreen jump to latest', () => {
  it('shows no label while the viewport follows the tail', async () => {
    const { tui, frame } = openViewport()
    const screen = await frame()
    expect(tui.isFollowingOutput).toBe(true)
    expect(screen.some(row => row.includes(LABEL))).toBe(false)
  })

  it('centers the button above the composer without covering the transcript', async () => {
    const { tui, frame, rows } = openViewport()
    await frame()
    tui.scrollBy(-20)
    const screen = await frame()
    expect(tui.isFollowingOutput).toBe(false)
    expect(screen.some(row => row.includes(rows[rows.length - 1] as string))).toBe(false)
    expect(screen[screen.length - 2]?.trimEnd()).toBe(' '.repeat(8) + ' ↓ Back to bottom · esc')
    expect(screen[screen.length - 1]).toContain('EDITOR')
    expect(screen[screen.length - 3]).toContain('row')
  })

  it('returns to the tail when the label is clicked', async () => {
    const { terminal, tui, frame, rows } = openViewport()
    await frame()
    tui.scrollBy(-20)
    const scrolled = await frame()
    const labelRow = scrolled.findIndex(row => row.includes(LABEL))
    const labelColumn = (scrolled[labelRow] as string).indexOf(LABEL)
    expect(labelRow).toBeGreaterThanOrEqual(0)
    // SGR mouse reports 1-based coordinates; the label starts at its arrow.
    const x = labelColumn + 2
    const y = labelRow + 1
    terminal.onInput?.('\u001B[<0;' + String(x) + ';' + String(y) + 'M')
    terminal.onInput?.('\u001B[<0;' + String(x) + ';' + String(y) + 'm')
    const clicked = await frame()
    expect(tui.isFollowingOutput).toBe(true)
    expect(clicked.some(row => row.includes(rows[rows.length - 1] as string))).toBe(true)
    expect(clicked.some(row => row.includes(LABEL))).toBe(false)
  })

  it('ignores clicks in the left padding and realigns after a resize', async () => {
    const { terminal, tui, frame } = openViewport()
    await frame()
    tui.scrollBy(-20)
    const screen = await frame()
    const y = screen.findIndex(row => row.includes(LABEL)) + 1
    terminal.onInput?.('\x1b[<0;1;' + y + 'M')
    terminal.onInput?.('\x1b[<0;1;' + y + 'm')
    await frame()
    expect(tui.isFollowingOutput).toBe(false)
    terminal.columns = 60
    const resized = await frame()
    expect(resized[resized.length - 2]?.trimEnd()).toBe(' '.repeat(18) + ' ↓ Back to bottom · esc')
    terminal.onInput?.('\x1b[1;5F')
    await frame()
    expect(tui.isFollowingOutput).toBe(true)
  })
})

