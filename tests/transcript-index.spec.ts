import { describe, expect, it } from 'vitest'
import { createTranscriptReducer, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 10, palette, markdown: markdownTheme(palette) }
function event(type: string, data: unknown, seq: number): TranscriptEntry {
  return { type: 'event', event: { type, data, seq, time: 0 } as SessionEvent }
}
const call = (id: string, seq: number) => event('tool/call', { turn: 1, step: 1, callId: id, name: 'read', arguments: '{"file_path":"a.ts"}' }, seq)

class CountingMap extends Map<number, string> {
  scannedValues = 0
  override values(): MapIterator<string> {
    this.scannedValues += this.size
    return super.values()
  }
}
function memory() {
  return { settled: new Set<string>(), pruned: new Set<string>(), prunedSeqs: new Set<number>(),
    callBySeq: new CountingMap(), knownCalls: new Set<string>() }
}

describe('tool identity index', () => {
  it('processes new tool calls without repeatedly enumerating all historical identities', () => {
    const toolMemory = memory()
    const reducer = createTranscriptReducer({ ...options, toolMemory })
    const entries = Array.from({ length: 2000 }, (_, index) => call('c' + index, index))
    reducer.append(entries)
    const result = reducer.reduce()
    expect(result.blocks.filter(block => block.kind === 'tool')).toHaveLength(10)
    expect(toolMemory.callBySeq.size).toBe(2000)
    expect(toolMemory.callBySeq.scannedValues).toBeLessThanOrEqual(2000)
  })

  it('remembers pending identities across window rebuilds but permits replay of the original seq', () => {
    const toolMemory = memory()
    const first = createTranscriptReducer({ ...options, toolMemory })
    first.append([call('old', 1)])
    const later = createTranscriptReducer({ ...options, toolMemory })
    later.append([call('new', 2), call('old', 3)])
    expect(later.reduce().blocks.filter(block => block.kind === 'tool').map(block => block.callId)).toEqual(['new'])
    const replay = createTranscriptReducer({ ...options, toolMemory })
    replay.append([call('old', 1)])
    expect(replay.reduce().blocks.filter(block => block.kind === 'tool').map(block => block.callId)).toEqual(['old'])
  })

  it('indexes PTC sub-calls and orphan results as known identities', () => {
    const toolMemory = memory()
    const initial = createTranscriptReducer({ ...options, toolMemory })
    initial.append([
      event('tool/ptc-dispatch-start', { subCallId: 'ptc', name: 'write', arguments: { file_path: 'a.ts', content: 'a' } }, 1),
      event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'orphan' }, content: [], isError: false } }, 2),
    ])
    const later = createTranscriptReducer({ ...options, toolMemory })
    later.append([call('ptc', 3), call('orphan', 4)])
    expect(later.reduce().blocks).toEqual([])
  })

  it('clears identity memory when the renderer changes sessions', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.setEntries([call('same', 1)])
    renderer.clear()
    renderer.setEntries([call('same', 2)])
    expect(renderer.container.render(80).join('\n')).toContain('read')
  })
})
