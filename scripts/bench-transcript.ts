/**
 * Reproducible local benchmark for the transcript rebuild path that runs on
 * every streaming frame. Reports median milliseconds per frame for (A) session
 * length and (B) live chunks accumulating behind the streaming block.
 *
 * Run with: node_modules/.bin/tsx scripts/bench-transcript.ts
 *
 * 2026-10-17 baseline, before component reuse: 600 turns cost 76.5 ms/frame and
 * a streaming frame with 100 pending chunks cost 24.4 ms - both above the 33 ms
 * render throttle, which is what "laggy streaming" looked like. Reusing
 * unchanged block components moved those to 2.4 ms and 0.4 ms.
 */
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { TranscriptRenderer, type TranscriptEntry } from '../src/ui/transcript.js'

const palette = createPalette('dark')
const options = { showReasoning: true, maxEntries: 2000, palette, markdown: markdownTheme(palette) } as never

function makeEntries(turns: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let seq = 1
  for (let t = 0; t < turns; t += 1) {
    entries.push({ type: 'event', event: {
      type: 'user/message', seq: seq++, time: 0,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question ' + t + ' ' + 'detail '.repeat(20) }] },
    } } as never)
    entries.push({ type: 'event', event: {
      type: 'assistant/message', seq: seq++, time: 0,
      data: { turn: t, step: 0, message: { content: [
        { type: 'reasoning', text: 'thinking about it '.repeat(15) },
        { type: 'text', text: '## Answer ' + t + '\n\n' + 'lorem ipsum dolor sit amet consectetur '.repeat(20) + '\n\n- alpha\n- beta\n- gamma\n' },
      ] } },
    } } as never)
  }
  return entries
}

function live(seq: number, turn: number): TranscriptEntry {
  return { type: 'live', event: {
    type: 'assistant/live-chunk', seq, time: 0,
    data: { attemptId: 'a', turn, step: 0, chunk: { type: 'text-delta', text: 'streamed token ' } },
  } } as never
}

function measure(label: string, fn: () => void, runs = 5): number {
  fn()
  const times: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(runs / 2)]!
  console.log(label.padEnd(44) + 'median ' + median.toFixed(1) + ' ms   min ' + times[0]!.toFixed(1))
  return median
}

console.log('=== A. rebuild + render cost vs session length ===')
for (const turns of [50, 200, 600]) {
  const entries = makeEntries(turns)
  const renderer = new TranscriptRenderer(options)
  measure(turns + ' turns (2 events each)', () => {
    renderer.set(entries, [])
    renderer.container.render(120)
  }, 3)
}

console.log('')
console.log('=== B. streaming: cost as live chunks accumulate ===')
{
  const base = makeEntries(200)
  const renderer = new TranscriptRenderer(options)
  renderer.set(base, [])
  renderer.container.render(120)
  let seq = 500000
  const frame = () => {
    seq += 1
    base.push(live(seq, 500))
    renderer.set(base, [])
    renderer.container.render(120)
  }
  measure('frame 1 (no backlog)', () => { while (base.length > 400) base.pop(); frame() }, 3)
  for (let i = 0; i < 100; i += 1) frame()
  measure('frame after 100 chunks', frame, 3)
  for (let i = 0; i < 200; i += 1) frame()
  measure('frame after 300 chunks', frame, 3)
}
