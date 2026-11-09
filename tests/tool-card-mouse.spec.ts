import { Box, ScrollView, Text, TuiAltScreen, VStack, stripTerminalSequences } from '@earendil-works/pi-tui'
import { expect, it, onTestFinished } from 'vitest'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

class Terminal {
  columns = 80
  rows = 16
  kittyProtocolActive = false
  onInput: ((data: string) => void) | undefined
  onFrame: (() => void) | undefined
  start(onInput: (data: string) => void): void { this.onInput = onInput }
  stop(): void { this.onInput = undefined }
  async drainInput(): Promise<void> {}
  write(data: string): void { if (data.includes('\x1b[?2026l')) this.onFrame?.() }
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

it('routes SGR press/release through fullscreen layout and a scrolled transcript to the memoized tool card', async () => {
  const terminal = new Terminal()
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true })
  onTestFinished(() => { tui.stop() })
  const palette = createPalette('plain')
  const renderer = new TranscriptRenderer({ palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 })
  renderer.set([], [{ kind: 'tool', callId: 'mouse', name: 'read', args: '{"file_path":"src/a.ts"}', pending: false, result: 'MOUSE_EXPANDED_ONE\nMOUSE_EXPANDED_TWO' }])
  const transcript = new Box(0, 1)
  transcript.addChild(new Text(Array.from({ length: 80 }, (_, index) => 'history_' + index).join('\n'), 0, 0))
  transcript.addChild(renderer.container)
  tui.setLayoutRoot(new VStack([
    { component: new Text('HEADER\nWORKSPACE', 0, 0), basis: 'auto' },
    { component: new ScrollView(transcript, { follow: 'end', primary: true }), basis: 0, grow: 1, minSize: 1 },
    { component: new Text('STATUS\nEDITOR', 0, 0), basis: 'auto' },
  ]))
  const frame = async (action: () => void): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = new Promise<void>((resolve, reject) => {
      terminal.onFrame = resolve
      timer = setTimeout(() => { reject(new Error('fullscreen frame did not complete')) }, 5000)
    })
    try {
      action()
      await completed
      return tui.getScreenLines().map(stripTerminalSequences)
    } finally {
      clearTimeout(timer)
      terminal.onFrame = undefined
    }
  }
  const clickTitle = (screen: string[]): void => {
    const row = screen.findIndex(line => line.includes('Read src/a.ts'))
    expect(row).toBeGreaterThan(1)
    const column = screen[row]!.indexOf('Read src/a.ts')
    const position = (column + 1) + ';' + (row + 1)
    terminal.onInput?.('\x1b[<0;' + position + 'M')
    terminal.onInput?.('\x1b[<0;' + position + 'm')
  }
  const collapsed = await frame(() => { tui.start() })
  expect(collapsed.some(line => line.includes('history_0'))).toBe(false)
  expect(collapsed.some(line => line.includes('MOUSE_EXPANDED_ONE'))).toBe(false)
  const expanded = await frame(() => { clickTitle(collapsed) })
  expect(expanded.some(line => line.includes('MOUSE_EXPANDED_ONE'))).toBe(true)
  expect(expanded.some(line => line.includes('MOUSE_EXPANDED_TWO'))).toBe(true)
  const restored = await frame(() => { clickTitle(expanded) })
  expect(restored.some(line => line.includes('MOUSE_EXPANDED_ONE'))).toBe(false)
})
