import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createTranscriptReducer, type TranscriptEntry } from '../src/ui/transcript.js'
import { COMPACT_SLACK } from '../src/ui/transcript-compaction.js'
import { toolMemoryLimit } from '../src/ui/transcript-memory.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }

function event(type: string, data: unknown, seq: number): TranscriptEntry {
  return { type: 'event', event: { type, data, seq, time: seq } as SessionEvent }
}

const user = (seq: number) => event('user/message', {
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'm' + String(seq).padStart(5, '0') }],
}, seq)

const call = (callId: string, seq: number) => event('tool/call', {
  turn: 1, step: 1, callId, name: 'read', arguments: '{}',
}, seq)

const result = (callId: string, seq: number) => event('tool/result', {
  turn: 1, step: 1,
  message: { source: { callId }, content: [{ type: 'text', text: 'OUT ' + callId }], isError: false },
}, seq)

const prune = (shadowedSeq: number, seq: number) => event('compaction/prune', {
  shadowedSeqs: [shadowedSeq], shadowedTokenCount: 100,
}, seq)

const memory = () => ({
  settled: new Set<string>(),
  pruned: new Set<string>(),
  prunedSeqs: new Set<number>(),
  callBySeq: new Map<number, string>(),
  knownCalls: new Set<string>(),
})

describe('large transcript append', () => {
  it('compacts final blocks during a cold append instead of keeping every event', () => {
    const entries = Array.from({ length: 20_000 }, (_, index) => user(index + 1))
    const reducer = createTranscriptReducer(options)
    reducer.append(entries)
    // Only the settled prefix beyond the retained window is removed, and the
    // list never reaches the 20k blocks a full materialization would create.
    expect(reducer.blockCount).toBeLessThanOrEqual(options.maxEntries + COMPACT_SLACK)
    expect(reducer.blockCount).toBeLessThan(entries.length)

    const reduction = reducer.reduce()
    expect(reduction.blocks[0]).toMatchObject({ kind: 'notice', tone: 'info' })
    expect(reduction.blocks).toHaveLength(options.maxEntries + 1)
    expect(reduction.blocks.slice(1).map(block => block.kind === 'user' ? block.text : '')).toEqual(
      Array.from({ length: options.maxEntries }, (_, index) => 'm' + String(19_901 + index).padStart(5, '0')),
    )
  })
})

describe('bounded tool memory', () => {
  it('caps identity maps and sets over a long tool history', () => {
    const toolMemory = memory()
    const entries: TranscriptEntry[] = []
    for (let index = 0; index < 12_000; index += 1) {
      const seq = index * 2 + 1
      entries.push(call('c' + String(index), seq), result('c' + String(index), seq + 1))
    }
    const reducer = createTranscriptReducer({ ...options, toolMemory })
    reducer.append(entries)
    reducer.reduce()
    const limit = toolMemoryLimit(options.maxEntries)
    expect(toolMemory.callBySeq.size).toBeLessThanOrEqual(limit)
    expect(toolMemory.knownCalls.size).toBeLessThanOrEqual(limit)
    expect(toolMemory.settled.size).toBeLessThanOrEqual(limit)
    // The newest call is still addressable; the cap evicts oldest inserts.
    expect(toolMemory.callBySeq.has(24_000)).toBe(true)
    expect(toolMemory.callBySeq.has(1)).toBe(false)
  })

  it('caps prune sets as well', () => {
    const toolMemory = memory()
    const entries: TranscriptEntry[] = []
    for (let index = 0; index < 5000; index += 1) {
      const seq = index * 2 + 1
      entries.push(call('c' + String(index), seq), result('c' + String(index), seq + 1))
    }
    for (let index = 0; index < 5000; index += 1) entries.push(prune(index * 2 + 2, 10_001 + index))
    const reducer = createTranscriptReducer({ ...options, toolMemory })
    reducer.append(entries)
    reducer.reduce()
    const limit = toolMemoryLimit(options.maxEntries)
    expect(toolMemory.pruned.size).toBeLessThanOrEqual(limit)
    expect(toolMemory.prunedSeqs.size).toBeLessThanOrEqual(limit)
  })
})
