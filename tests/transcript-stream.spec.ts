import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { AssistantMessage } from '../src/ui/assistant-message.js'
import { clipGraphemes } from '../src/ui/grapheme-preview.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createTranscriptReducer, type TranscriptEntry } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, thinkingDisplay: 'detailed' as const, maxEntries: 600, palette, markdown: markdownTheme(palette) }
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 1_000 } as SessionEvent,
})
const chunk = (type: string, text: string, index = 0, seq = 1): Extract<TranscriptEntry, { type: 'live' }> => ({
  type: 'live', event: { type: 'assistant/live-chunk', seq, time: 1_000, data: {
    attemptId: 'a', turn: 1, step: 1, chunk: { type, text, index } as never,
  } },
})
const message = (content: Array<{ type: string; text: string }>, seq = 2): TranscriptEntry =>
  event('assistant/message', { turn: 1, step: 1, message: { content }, stream: [] }, seq)
const output = (renderer: TranscriptRenderer): string => renderer.container.render(120).join('\n')

describe('provider-driven stream projection', () => {
  it.each(['reasoning', 'text'] as const)('shows an entire %s burst on the first frame', type => {
    const renderer = new TranscriptRenderer(options)
    const text = 'received-'.repeat(2_000) + 'END-MARK'
    renderer.set([chunk(type + '-delta', text)], [])
    expect(output(renderer)).toContain('END-MARK')
    renderer.set([chunk(type + '-delta', text)], [])
    expect(renderer.contentChanged).toBe(false)
  })

  it.each(['reasoning', 'text'] as const)('shows a completed %s block without deltas or a follow-up frame', type => {
    const renderer = new TranscriptRenderer(options)
    const entry = chunk('block-end', '')
    Object.assign(entry.event.data, { chunk: { type: 'block-end', index: 0, block: { type, text: 'x'.repeat(20_000) + 'END-MARK' } } })
    renderer.set([entry], [])
    expect(output(renderer)).toContain('END-MARK')
  })

  it('renders reasoning, answer, tool and next step together in provider order', () => {
    const reducer = createTranscriptReducer(options)
    reducer.append([
      chunk('reasoning-delta', 'THOUGHT '.repeat(200) + 'THINKING-END'),
      chunk('text-delta', 'ANSWER', 1, 2),
      event('tool/call', { callId: 'tool-1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 3),
      event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'NEXT STEP' }] } }, 4),
    ])
    const reduction = reducer.reduce()
    expect(reduction.blocks.map(block => block.kind)).toEqual(['assistant', 'tool', 'assistant'])
    expect(reduction.blocks[0]).toMatchObject({ reasoning: expect.stringContaining('THINKING-END'), text: 'ANSWER' })
    expect(reduction.blocks[2]).toMatchObject({ text: 'NEXT STEP' })
  })

  it('uses the final message immediately when it replaces live entries before the first paint', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([message([{ type: 'reasoning', text: 'x'.repeat(20_000) + 'THINKING-END' }, { type: 'text', text: 'ANSWER' }])], [])
    expect(output(renderer)).toContain('THINKING-END')
    expect(output(renderer)).toContain('ANSWER')
  })

  it.each(['reasoning', 'text'] as const)('does not rewind displayed %s on durable replacement', type => {
    const renderer = new TranscriptRenderer(options)
    const content = 'received-'.repeat(200) + 'END-MARK'
    renderer.set([chunk(type + '-delta', content)], [])
    const before = output(renderer)
    renderer.set([message([{ type, text: content }])], [])
    expect(output(renderer)).toBe(before)
  })

  it('does not hold received text behind an explicitly open reasoning block', () => {
    const renderer = new TranscriptRenderer(options)
    const start = chunk('block-start', '')
    Object.assign(start.event.data, { chunk: { type: 'block-start', blockType: 'reasoning', index: 0 } })
    renderer.set([start], [])
    expect(output(renderer)).toContain('thinking …')
    renderer.set([start, chunk('text-delta', 'ANSWER', 1, 2)], [])
    expect(output(renderer)).toContain('ANSWER')
  })

  it('preserves alternating content parts through settlement', () => {
    const renderer = new TranscriptRenderer(options)
    const parts = [
      { type: 'text', text: 'INTRO' },
      { type: 'reasoning', text: 'THOUGHT A' },
      { type: 'text', text: 'MIDDLE' },
      { type: 'reasoning', text: 'THOUGHT B' },
      { type: 'text', text: 'FINAL' },
    ]
    renderer.set(parts.map((part, index) => chunk(part.type + '-delta', part.text, index, index + 1)), [])
    const assertOrder = () => {
      const text = output(renderer)
      const positions = parts.map(part => text.indexOf(part.text))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
    assertOrder()
    renderer.set([message(parts, 10)], [])
    assertOrder()
  })

  it('shows a partial response and its failure together without waiting for more chunks', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      chunk('reasoning-delta', 'x'.repeat(20_000) + 'PARTIAL-END'),
      event('turn/end', { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'connection closed' } } }, 2),
    ], [])
    const text = output(renderer)
    expect(text).toContain('PARTIAL-END')
    expect(text).toContain('Turn failed: TRANSPORT: connection closed')
  })

  it('keeps a failed attempt separate from its retry', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      chunk('text-delta', 'FAILED'),
      event('assistant/attempt', { turn: 1, step: 1, stream: [] }, 2),
      chunk('text-delta', 'RETRY '.repeat(200) + 'RETRY-END'),
    ], [])
    expect(output(renderer)).not.toContain('FAILED')
    expect(output(renderer)).toContain('RETRY-END')
  })

  it('does not leak content across sessions', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([chunk('text-delta', 'OLD SESSION')], [])
    renderer.clear()
    renderer.set([message([{ type: 'text', text: 'NEW SESSION' }])], [])
    expect(output(renderer)).toContain('NEW SESSION')
    expect(output(renderer)).not.toContain('OLD SESSION')
  })

  it('keeps compact and hidden thinking modes and restores full detailed history', () => {
    const renderer = new TranscriptRenderer(options)
    const reasoning = 'COMPACT-FIRST-LINE\n' + 'detail\n'.repeat(1_000) + 'HISTORY-THINKING-END'
    renderer.set([message([{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ANSWER' }])], [])
    expect(output(renderer)).toContain('HISTORY-THINKING-END')
    renderer.setDisplayModes('compact', 'detailed')
    expect(output(renderer)).toContain('thinking · COMPACT-FIRST-LINE')
    expect(output(renderer)).not.toContain('HISTORY-THINKING-END')
    renderer.setDisplayModes('hidden', 'detailed')
    expect(output(renderer)).not.toContain('COMPACT-FIRST-LINE')
    expect(output(renderer)).toContain('ANSWER')
    renderer.setDisplayModes('detailed', 'detailed')
    expect(output(renderer)).toContain('HISTORY-THINKING-END')
  })
})

describe('incremental transcript folding', () => {
  it('never rereads accumulated chunks on unchanged frames or appended suffixes', () => {
    const renderer = new TranscriptRenderer(options)
    let reads = 0
    const entries: TranscriptEntry[] = []
    for (let index = 0; index < 10_000; index += 1) {
      const entry = chunk('text-delta', 'x', 0, index)
      const value = entry.event.data.chunk
      Object.defineProperty(entry.event.data, 'chunk', { get: () => { reads += 1; return value } })
      entries.push(entry)
    }
    renderer.set(entries, [])
    expect(reads).toBe(10_000)
    for (let frame = 0; frame < 10; frame += 1) renderer.set(entries, [])
    expect(reads).toBe(10_000)
    entries.push(chunk('text-delta', 'tail', 0, 10_001))
    renderer.set(entries, [])
    expect(reads).toBe(10_000)
  })

  it('replays replacements and trims old history', () => {
    const renderer = new TranscriptRenderer({ ...options, maxEntries: 4 })
    let entries: TranscriptEntry[] = []
    for (let seq = 1; seq <= 100; seq += 1) {
      entries.push(event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'row-' + seq }] }, seq))
      renderer.set(entries, [])
      if (renderer.retainedFrom > 0) entries = entries.slice(renderer.retainedFrom)
    }
    expect(entries.length).toBeLessThanOrEqual(8)
    expect(output(renderer)).toContain('row-100')
    renderer.set([message([{ type: 'text', text: 'REPLACED HISTORY' }])], [])
    expect(output(renderer)).toContain('REPLACED HISTORY')
    expect(output(renderer)).not.toContain('row-100')
  })

  it('reuses completed thinking components while the answer grows', () => {
    const component = new AssistantMessage({ kind: 'assistant', text: 'hello', reasoning: 'THOUGHT', live: true }, options)
    const thinking = component.children[2]!
    const body = component.children.at(-1)!
    component.render(80)
    const paint = vi.spyOn(thinking, 'render')
    component.update({ kind: 'assistant', text: 'hello world', reasoning: 'THOUGHT', live: true })
    expect(component.children[2]).toBe(thinking)
    expect(component.children.at(-1)).toBe(body)
    component.render(80)
    expect(paint).toHaveBeenCalledOnce()
  })
})

describe('Unicode content', () => {
  it.each(['e\u0301', '👩‍💻', '🇨🇳', '🧠'])('does not truncate received %s text', grapheme => {
    const renderer = new TranscriptRenderer(options)
    const text = grapheme.repeat(80)
    renderer.set([chunk('text-delta', text)], [])
    expect(output(renderer)).toContain(grapheme.repeat(10))
    const blocks = createTranscriptReducer(options)
    blocks.append([chunk('text-delta', text)])
    expect(blocks.reduce().blocks[0]).toMatchObject({ text })
  })

  it('clips compact previews at grapheme boundaries', () => {
    const text = 'abcdef👩‍💻ghijkl'
    expect(clipGraphemes(text, 3)).toBe('abc\n… [10 chars omitted]')
    expect(clipGraphemes(text, 8)).toBe('abcdef👩‍💻g\n… [5 chars omitted]')
  })
})
