import { Container, Text, TuiMainScreen } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import type { TranscriptBlock, TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'

/**
 * The renderer under test needs a terminal, but the assertion is about pi-tui's
 * differential renderer, not about terminal I/O: this fake only records sizes
 * and swallows writes.
 */
class FakeTerminal {
  private readonly columnsValue: number
  private readonly rowsValue: number
  constructor(columns: number, rows: number) {
    this.columnsValue = columns
    this.rowsValue = rows
  }
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number { return this.columnsValue }
  get rows(): number { return this.rowsValue }
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

const palette = createPalette('plain')
const options = {
  showReasoning: true,
  maxEntries: 100,
  palette,
  markdown: markdownTheme(palette),
}

const FILLER = Array.from({ length: 600 }, (_, index) => 'filler ' + String(index)).join('\n')
// A live card is the transcript tail: only the wait row (and the chrome that
// main-screen always keeps below the transcript) can follow it. Few trailing
// rows are what keeps the card's own mutations inside the viewport.
const TRAILING = Array.from({ length: 2 }, (_, index) => 'after ' + String(index)).join('\n')

/**
 * Render one transcript card with its head already scrolled above the viewport
 * in main-screen mode, swap it for that card's next lifecycle state, and report
 * whether pi-tui had to repaint the whole screen.
 * @param before - the card as it first appears.
 * @param after - the same card after its lifecycle advanced.
 * @returns the number of full redraws the swap caused.
 */
function redrawsForSwap(before: TranscriptBlock, after: TranscriptBlock): number {
  const tui = new TuiMainScreen(new FakeTerminal(100, 30) as never, false)
  const root = new Container()
  root.addChild(new Text(FILLER, 0, 0))
  root.addChild(renderTranscriptBlock(before, options))
  root.addChild(new Text(TRAILING, 0, 0))
  tui.addChild(root)
  tui.start()
  tui.renderNow()
  const baseline = tui.fullRedraws
  root.removeChild(root.children[1]!)
  root.children.splice(1, 0, renderTranscriptBlock(after, options))
  tui.renderNow()
  const redraws = tui.fullRedraws - baseline
  tui.stop()
  return redraws
}

describe('main-screen card lifecycle', () => {
  it('patches a tool card whose status moves to the tail row', () => {
    const args = JSON.stringify({ command: 'ls', note: Array.from({ length: 30 }, (_, i) => 'n' + String(i)).join('\n') })
    const pending: TranscriptBlock = { kind: 'tool', callId: 'c1', name: 'bash', args, pending: true }
    const settled: TranscriptBlock = { kind: 'tool', callId: 'c1', name: 'bash', args, result: 'file.txt', pending: false }
    // A head row that carries the run state sits above the viewport by the time
    // the result lands, and main-screen can only patch rows that are visible.
    expect(redrawsForSwap(pending, settled)).toBe(0)
  })

  it('patches a compaction card whose state moves to the tail row', () => {
    // A long summary makes the card taller than the viewport, so its head row
    // sits above the visible area once the card has settled.
    const summary = Array.from({ length: 40 }, (_, index) => 'summary line ' + String(index)).join('\n')
    const running: TranscriptBlock = { kind: 'compaction', compactionId: 'k', state: 'running', summary, seq: 1 }
    const done: TranscriptBlock = {
      kind: 'compaction',
      compactionId: 'k',
      state: 'done',
      shadowedItems: 3,
      shadowedTokens: 900,
      summary,
      seq: 2,
    }
    expect(redrawsForSwap(running, done)).toBe(0)
  })

  it('still repaints when a head row does change above the viewport', () => {
    // Control case: without the invariant this suite guards, the swap above
    // would be indistinguishable from a safe one.
    const tui = new TuiMainScreen(new FakeTerminal(100, 30) as never, false)
    const root = new Container()
    root.addChild(new Text(FILLER, 0, 0))
    const head = new Text('CARD HEAD running', 0, 0)
    root.addChild(head)
    // Push the head above the viewport on purpose: this case asserts that the
    // harness detects a repaint when the invariant is violated.
    root.addChild(new Text(Array.from({ length: 40 }, (_, index) => 'after ' + String(index)).join('\n'), 0, 0))
    tui.addChild(root)
    tui.start()
    tui.renderNow()
    const baseline = tui.fullRedraws
    head.setText('CARD HEAD done')
    tui.renderNow()
    expect(tui.fullRedraws - baseline).toBeGreaterThan(0)
    tui.stop()
  })
})

describe('main-screen saturated window', () => {
  it('repaints once per trim batch instead of once per arriving block', () => {
    // The window tops out at a cap; main-screen repaints the whole transcript
    // every time a row above the viewport changes, so trimming per block clears
    // the screen on every arrival. The reducer trims in batches instead.
    const cap = 60
    const renderer = new TranscriptRenderer({ ...options, maxEntries: cap })
    const tui = new TuiMainScreen(new FakeTerminal(100, 30) as never, false)
    tui.addChild(renderer.container)
    tui.start()
    let entries: TranscriptEntry[] = []
    const user = (seq: number) => ({
      type: 'event' as const,
      event: {
        type: 'user/message',
        seq,
        time: 0,
        data: { content: [{ type: 'text', text: 'row ' + String(seq) }], source: { kind: 'user' } },
      } as never,
    })
    renderer.set(entries, [])
    tui.renderNow()
    const baseline = tui.fullRedraws
    for (let seq = 1; seq <= 200; seq += 1) {
      entries.push(user(seq))
      renderer.set(entries, [])
      if (renderer.retainedFrom > 0) entries = entries.slice(renderer.retainedFrom)
      tui.renderNow()
    }
    const redraws = tui.fullRedraws - baseline
    tui.stop()
    // 200 arrivals against a 60-row cap: per-block trimming would repaint on
    // every arrival once saturated; batched trimming repaints a handful of times.
    expect(redraws).toBeLessThan(10)
  })
})

