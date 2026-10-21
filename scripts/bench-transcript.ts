/**
 * Reproducible local benchmark for the transcript rebuild path that runs on
 * every streaming frame. Reports median milliseconds per frame for (A) session
 * length, (B) live chunks accumulating behind the streaming block, and
 * (C) a saturated window where every new row shifts the block list.
 *
 * Run with: node_modules/.bin/tsx scripts/bench-transcript.ts
 *
 * F includes 10,000 live deltas in a long session with an active detailed
 * thinking stream; each frame appends one delta without replaying prior ones.
 */
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { reduceTranscriptWindow, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'

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

function liveReasoning(seq: number, turn: number, time: number): TranscriptEntry {
  return { type: 'live', event: {
    type: 'assistant/live-chunk', seq, time,
    data: { attemptId: 'a', turn, step: 0, chunk: {
      type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought '.repeat(375) },
    } },
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
  console.log(label.padEnd(48) + 'median ' + median.toFixed(1) + ' ms   min ' + times[0]!.toFixed(1))
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

console.log('')
console.log('=== C. saturated window: one appended row shifts every block index ===')
for (const cap of [200, 2000]) {
  const entries = makeEntries(cap + 100)
  const renderer = new TranscriptRenderer({ ...(options as object), maxEntries: cap } as never)
  renderer.set(entries, [])
  renderer.container.render(120)
  let seq = 900000
  const shift = (): void => {
    seq += 1
    entries.push({ type: 'event', event: {
      type: 'assistant/message', seq, time: 0,
      data: { turn: seq, step: 0, message: { content: [{ type: 'text', text: '## More\n\n' + 'lorem ipsum dolor sit amet '.repeat(20) }] } },
    } } as never)
  }
  // Warm the shift path before measuring steady-state frames.
  for (let i = 0; i < 4; i += 1) {
    shift()
    renderer.set(entries, [])
    renderer.container.render(120)
  }
  measure('cap ' + cap + ' saturated shift frame (set + render)', () => {
    shift()
    renderer.set(entries, [])
    renderer.container.render(120)
  })
}

console.log('')
console.log('=== D. large completed reasoning block (reduce only) ===')
{
  const entries = [...makeEntries(600), liveReasoning(900000, 600, 1_000)]
  measure('600 turns + completed reasoning', () => {
    reduceTranscriptWindow(entries, options)
  }, 9)
}

console.log('')
console.log('=== E. repeat paint of an unchanged window (the per-row memo) ===')
for (const turns of [200, 600, 2000]) {
  const entries = makeEntries(turns)
  const renderer = new TranscriptRenderer(options)
  renderer.set(entries, [])
  renderer.container.render(120)
  // The rows are unchanged, so this is what one streaming frame pays for the
  // retained transcript: without the memo it walked every child again.
  measure(turns + ' turns repainted at the same width', () => {
    renderer.container.render(120)
  })
}

console.log('')
console.log('=== F. long session + 10,000 thinking deltas, detailed display ===')
{
  const entries = makeEntries(600)
  let seq = 900000
  const append = (): void => {
    entries.push({ type: 'live', event: {
      type: 'assistant/live-chunk', seq: seq++, time: 0,
      data: { attemptId: 'long', turn: 601, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'thought ' } },
    } } as never)
  }
  for (let index = 0; index < 10_000; index += 1) append()
  const renderer = new TranscriptRenderer(options)
  for (let frame = 0; frame < 130; frame += 1) {
    renderer.set(entries, [])
    renderer.container.render(120)
  }
  measure('600 turns + 10,000 deltas (append + set + render)', () => {
    append()
    renderer.set(entries, [])
    renderer.container.render(120)
  }, 9)
}
