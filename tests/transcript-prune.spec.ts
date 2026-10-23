import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createTranscriptReducer, reduceTranscript, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }
const event = (type: string, data: unknown, seq: number, metadata = {}): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: seq, ...metadata } as SessionEvent,
})
const call = (id: string, seq: number) => event('tool/call', {
  turn: 1, step: 1, callId: id, name: 'read', arguments: '{}',
}, seq)
const result = (id: string, text: string, seq: number, metadata = {}) => event('tool/result', {
  turn: 1, step: 1,
  message: { source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }], isError: false },
}, seq, { surfaceOp: 'append', ...metadata })
const prune = (shadowedSeq: number, seq: number) => event('compaction/prune', {
  shadowedSeqs: [shadowedSeq], shadowedTokenCount: 900,
}, seq)
const replacement = (id: string, sourceSeq: number, seq: number) => result(id, 'shortened replacement', seq, {
  surfaceOp: { op: 'replace', startSeq: sourceSeq, endSeq: sourceSeq }, sourceEventSeqs: [sourceSeq],
})
const noticeText = (count: number) => 'Model context: ' + String(count) + ' tool result(s) shortened · history preserved'
const output = (renderer: TranscriptRenderer) => renderer.container.render(120).join('\n')

// A pruning pass emits one prune/replacement pair per over-budget result.
const batch = [prune(2, 5), replacement('a', 2, 6), prune(4, 7), replacement('b', 4, 8)]
const original = [call('a', 1), result('a', 'ORIGINAL A', 2), call('b', 3), result('b', 'ORIGINAL B', 4)]

describe('model-context pruning in the transcript', () => {
  it('keeps original output and coalesces interleaved prune/replacement pairs', () => {
    const blocks = reduceTranscript([...original, ...batch], options)
    expect(blocks).toMatchObject([
      { kind: 'tool', callId: 'a', result: 'ORIGINAL A' },
      { kind: 'tool', callId: 'b', result: 'ORIGINAL B' },
      { kind: 'notice', text: noticeText(2), seq: 5 },
    ])
    expect(blocks.some(block => block.kind === 'compaction')).toBe(false)
  })

  it('keeps a large pruning pass to one notice', () => {
    const entries: TranscriptEntry[] = []
    for (let index = 0; index < 30; index += 1) {
      entries.push(call(String(index), index * 2 + 1), result(String(index), 'ORIGINAL ' + String(index), index * 2 + 2))
    }
    for (let index = 0; index < 30; index += 1) {
      entries.push(prune(index * 2 + 2, 61 + index * 2), replacement(String(index), index * 2 + 2, 62 + index * 2))
    }
    const blocks = reduceTranscript(entries, options)
    expect(blocks.filter(block => block.kind === 'tool')).toHaveLength(30)
    expect(blocks.filter(block => block.kind === 'notice')).toMatchObject([{ text: noticeText(30) }])
  })

  it('coalesces a batch across incremental appends and paints', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [...original]
    renderer.set(entries, [])
    for (const entry of batch) {
      entries.push(entry)
      renderer.set(entries, [])
      const text = output(renderer)
      expect(text).toContain('ORIGINAL A')
      expect(text).toContain('ORIGINAL B')
      expect(text.match(/Model context:/g)).toHaveLength(1)
      expect(text).not.toContain('shortened replacement')
      expect(text).not.toContain('tokens')
    }
    expect(output(renderer)).toContain(noticeText(2))
    renderer.setDisplayModes('compact', 'compact')
    expect(output(renderer)).toContain('ORIGINAL A')
    expect(output(renderer)).toContain(noticeText(2))
    renderer.setEntries([...entries])
    expect(output(renderer).match(/Model context:/g)).toHaveLength(1)
  })

  it.each(['assistant', 'user', 'turn', 'live'] as const)('starts a new batch after a %s event', boundary => {
    const middle: TranscriptEntry = boundary === 'live'
      ? { type: 'live', event: { type: 'assistant/live-chunk', seq: 1, time: 1, data: {
        attemptId: 'a', turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'NEXT' },
      } } }
      : boundary === 'assistant'
        ? event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'NEXT' }] } }, 7)
        : boundary === 'user'
          ? event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'NEXT' }] }, 7)
          : event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7)
    const blocks = reduceTranscript([...original, ...batch.slice(0, 2), middle, prune(4, 8), replacement('b', 4, 9)], options)
    expect(blocks.filter(block => block.kind === 'notice')).toMatchObject([
      { text: noticeText(1), seq: 5 }, { text: noticeText(1), seq: 8 },
    ])
  })

  it('preserves a top-level edit diff and error state on replay', () => {
    const entries = [
      event('tool/call', { turn: 1, step: 1, callId: 'edit', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts' }) }, 1),
      event('tool/result', {
        turn: 1, step: 1,
        message: { source: { callId: 'edit' }, content: [{ type: 'text', text: 'ORIGINAL ERROR' }], isError: true },
        meta: { diffs: [{ path: 'a.ts', oldText: 'BEFORE', newText: 'AFTER' }] },
      }, 2),
      prune(2, 3), replacement('edit', 2, 4),
    ]
    const toolMemory = { settled: new Set<string>(), pruned: new Set<string>(), prunedSeqs: new Set<number>(), callBySeq: new Map<number, string>() }
    for (let pass = 0; pass < 2; pass += 1) {
      expect(reduceTranscript(entries, { ...options, toolMemory })[0]).toMatchObject({
        kind: 'tool', name: 'edit', isError: true, result: 'ORIGINAL ERROR',
        diffs: [{ path: 'a.ts', oldText: 'BEFORE', newText: 'AFTER' }],
      })
    }
  })

  it('ignores replacements after the original entries leave the window', () => {
    const toolMemory = { settled: new Set<string>(), pruned: new Set<string>(), prunedSeqs: new Set<number>(), callBySeq: new Map<number, string>() }
    const tracked = { ...options, toolMemory }
    reduceTranscript([...original, ...batch], tracked)
    expect(reduceTranscript(batch.slice(1, 2), tracked)).toEqual([])
    expect(reduceTranscript([result('a', 'late duplicate', 9)], tracked)).toEqual([])
    expect(reduceTranscript(original, tracked)).toMatchObject([
      { kind: 'tool', result: 'ORIGINAL A' }, { kind: 'tool', result: 'ORIGINAL B' },
    ])
  })

  it('coalesces replacement events even when the window starts at the prune batch', () => {
    const blocks = reduceTranscript(batch, options)
    expect(blocks).toMatchObject([{ kind: 'notice', text: noticeText(2) }])
  })

  it('counts a repeated shadowed sequence only once per batch', () => {
    const reducer = createTranscriptReducer(options)
    reducer.append([...original, prune(2, 5)])
    reducer.append([prune(2, 6)])
    expect(reducer.reduce().blocks.filter(block => block.kind === 'notice')).toMatchObject([{ text: noticeText(1) }])
  })
})
