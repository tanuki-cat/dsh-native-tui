import assert from 'node:assert/strict'
import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readTextPreview } from '../dist/runtime/files.js'
import { createTranscriptReducer } from '../dist/ui/transcript.js'
import { createPalette, markdownTheme } from '../dist/ui/theme.js'

// Run after pnpm build: node --expose-gc scripts/audit-perf.mjs.
if (global.gc === undefined) throw new Error('Run with --expose-gc')
const round = value => Number(value.toFixed(2))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
console.log(JSON.stringify({ node: process.version, platform: process.platform,
  excluded: 'fixture construction, terminal layout/paint, model/network latency',
  policy: 'manual diagnostic; no machine-dependent timing gate' }))

const root = await realpath(tmpdir())
const dir = await mkdtemp(join(root, 'native-tui-audit-perf-'))
try {
  const path = join(dir, 'large.log'), size = 128 * 1024 * 1024
  const file = await open(path, 'wx')
  try {
    await file.write(Buffer.alloc(16384, 97))
    await file.truncate(size)
  } finally { await file.close() }
  const samples = []
  for (let run = 0; run < 3; run++) {
    global.gc()
    const before = process.memoryUsage(), start = performance.now()
    const result = await readTextPreview(path)
    const ms = performance.now() - start, after = process.memoryUsage()
    assert.equal(result.text, 'a'.repeat(16384))
    assert.equal(result.bytes, size)
    assert.equal(result.truncated, true)
    samples.push({ ms: round(ms), arrayBuffersDeltaMiB: round((after.arrayBuffers - before.arrayBuffers) / 1024 / 1024),
      previewChars: result.text.length })
  }
  console.log(JSON.stringify({ operation: 'readTextPreview', fixtureBytes: size, maxPreviewBytes: 16384,
    samples, medianMs: median(samples.map(sample => sample.ms)) }))
} finally {
  if (dirname(dir) !== root || !dir.startsWith(join(root, 'native-tui-audit-perf-'))) throw new Error('unsafe cleanup target')
  await rm(dir, { recursive: true, force: true })
}

const palette = createPalette('plain')
for (const count of [2000, 4000, 8000, 16000]) {
  const entries = []
  for (let index = 0; index < count; index++) {
    const callId = 'c' + index, turn = Math.floor(index / 8) + 1, step = index % 8 + 1
    entries.push({ type: 'event', event: { type: 'tool/call', seq: index * 2, time: index,
      data: { turn, step, callId, name: index % 2 ? 'read' : 'bash', arguments: JSON.stringify(index % 2
        ? { file_path: 'src/module-' + index % 100 + '.ts' } : { command: 'git status --short' }) } } })
    entries.push({ type: 'event', event: { type: 'tool/result', seq: index * 2 + 1, time: index,
      data: { turn, step, message: { role: 'tool', source: { callId }, isError: false,
        content: [{ type: 'text', text: ('fixture line ' + index + '\n').repeat(30) }] } } } })
  }
  const samples = []
  for (let run = 0; run < 3; run++) {
    global.gc()
    const reducer = createTranscriptReducer({ showReasoning: true, maxEntries: 600, palette, markdown: markdownTheme(palette) })
    const start = performance.now()
    reducer.append(entries)
    const reduction = reducer.reduce()
    const elapsed = performance.now() - start
    assert.equal(reduction.blocks.filter(block => block.kind === 'tool').length, 600)
    assert.equal(reduction.blocks.at(-1).callId, 'c' + (count - 1))
    samples.push({ ms: round(elapsed), retainedBlocks: reduction.blocks.length })
  }
  console.log(JSON.stringify({ operation: 'cold transcript reduction (native Map, no instrumentation)',
    tools: count, events: entries.length, samples, medianMs: median(samples.map(sample => sample.ms)) }))
}
