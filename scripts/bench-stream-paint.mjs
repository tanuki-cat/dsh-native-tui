import assert from 'node:assert/strict'
import { Box, ScrollView, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../dist/ui/transcript-renderer.js'
import { TranscriptBody } from '../dist/ui/transcript-body.js'
import { createPalette, markdownTheme } from '../dist/ui/theme.js'

// Run after pnpm build. --legacy-box is the full-history padding negative control.
const legacyBox = process.argv.includes('--legacy-box')
const wrap = content => {
  if (!legacyBox) return new TranscriptBody(content)
  const box = new Box(0, 1)
  box.addChild(content)
  return box
}
const round = value => Number(value.toFixed(3))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

class FakeTerminal {
  columns = 120
  rows = 40
  bytes = 0
  start() {}
  stop() {}
  async drainInput() {}
  write(data) { this.bytes += Buffer.byteLength(data) }
  get kittyProtocolActive() { return false }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, legacyBox,
  workload: { historyMessages: 400, linesPerMessage: 20, activeReasoningLines: 500, width: 120, height: 40, samples: 15 },
  excluded: 'fixture setup, network/model latency, real stdout and terminal emulator',
  policy: 'manual diagnostic; no machine-dependent timing gate' }))

const palette = createPalette('dark')
const entries = Array.from({ length: 400 }, (_, turn) => ({ type: 'event', event: {
  type: 'assistant/message', seq: turn + 1, time: 0, data: { turn: turn + 1, step: 0, message: { content: [{
    type: 'reasoning', text: Array.from({ length: 20 }, (_, row) =>
      'Review ' + turn + '.' + row + ': 检查数据更新与输出顺序，preserve the visible content and completed work.').join('\n'),
  }] } },
} }))
const renderer = new TranscriptRenderer({ showReasoning: true, thinkingDisplay: 'detailed', runCodeDisplay: 'compact',
  maxEntries: 600, palette, markdown: markdownTheme(palette) })
const terminal = new FakeTerminal()
const tui = new TuiAltScreen(terminal, false)
tui.setLayoutRoot(new VStack([
  { component: new Text('Synthetic performance fixture', 0, 0), basis: 'auto' },
  { component: new ScrollView(wrap(renderer.container), { follow: 'end', primary: true }), basis: 0, grow: 1, minSize: 1 },
  { component: new Text('working\neditor\nstatus\nfooter', 0, 0), basis: 'auto' },
]))
let seq = 1000
function append(type, index, text) {
  entries.push({ type: 'live', event: { type: 'assistant/live-chunk', seq: seq++, time: 0,
    data: { attemptId: 'synthetic', turn: 401, step: 0, chunk: { type, index, text } } } })
}

renderer.set(entries, [])
renderer.container.render(120)
try {
  tui.start()
  tui.renderNow()
  const historyLines = renderer.container.render(120).length
  append('reasoning-delta', 0, Array.from({ length: 500 }, (_, row) =>
    'Active reasoning ' + row + ': 逐行检查执行结果，keep earlier lines stable while the stream continues.').join('\n') + '\n')
  for (const phase of ['reasoning', 'answer']) {
    const samples = []
    for (let frame = 0; frame < 20; frame++) {
      append(phase === 'reasoning' ? 'reasoning-delta' : 'text-delta', phase === 'reasoning' ? 0 : 1,
        phase + ' ' + frame + ': 新增内容与已有顺序保持一致。\n')
      const start = performance.now()
      renderer.set(entries, [])
      const rebuildMs = performance.now() - start
      const beforePaint = performance.now()
      tui.renderNow()
      const paintMs = performance.now() - beforePaint
      if (frame >= 5) samples.push({ rebuildMs: round(rebuildMs), paintMs: round(paintMs), totalMs: round(performance.now() - start) })
    }
    const lines = renderer.container.render(120)
    assert.ok(lines.join('\n').includes(phase + ' 19:'))
    console.log(JSON.stringify({ phase, historyLines, renderedLines: lines.length, bytes: terminal.bytes, samples,
      medianMs: { rebuild: median(samples.map(s => s.rebuildMs)), paint: median(samples.map(s => s.paintMs)),
        total: median(samples.map(s => s.totalMs)) } }))
  }
} finally {
  tui.stop()
}
