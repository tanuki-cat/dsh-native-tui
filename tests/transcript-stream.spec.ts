import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { AssistantMessage } from '../src/ui/assistant-message.js'
import { clipGraphemes, revealStreamText, STREAM_TEXT_MAX_STEP } from '../src/ui/reasoning-reveal.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createTranscriptReducer, type TranscriptEntry, type TranscriptBlock } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, thinkingDisplay: 'detailed' as const, maxEntries: 600, palette, markdown: markdownTheme(palette) }
const event = (type: string, data: unknown, seq: number, time = 1_000): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time } as SessionEvent,
})
const chunk = (type: string, text: string, index = 0, seq = 1): TranscriptEntry => ({
  type: 'live', event: { type: 'assistant/live-chunk', seq, time: 1_000, data: {
    attemptId: 'a', turn: 1, step: 1, chunk: { type, text, index } as never,
  } },
})
const message = (content: Array<{ type: string; text: string }>, seq = 2): TranscriptEntry =>
  event('assistant/message', { turn: 1, step: 1, message: { content }, stream: [] }, seq)
const output = (renderer: TranscriptRenderer): string => renderer.container.render(120).join('\n')
const assistant = (blocks: readonly TranscriptBlock[]) => blocks.find(block => block.kind === 'assistant') as Extract<TranscriptBlock, { kind: 'assistant' }>

afterEach(() => vi.useRealTimers())

describe('ordered stream projection', () => {
  it('does not let a large live thinking burst snap or expose its answer or next step', () => {
    const reducer = createTranscriptReducer({ ...options, revealProgress: new Map() })
    reducer.append([
      chunk('reasoning-delta', 'thought-'.repeat(200)),
      chunk('text-delta', 'answer-'.repeat(200), 1, 2),
      event('tool/call', { callId: 'tool-1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 3),
      event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'NEXT STEP' }] } }, 4),
    ])
    let shown = 0
    for (let frame = 0; frame < 150; frame += 1) {
      const reduction = reducer.reduce(10_000 + frame * 500)
      const block = assistant(reduction.blocks)
      const length = (block.reasoning?.length ?? 0) + block.text.length
      expect(length - shown).toBeLessThanOrEqual(STREAM_TEXT_MAX_STEP)
      shown = length
      if ((block.reasoning?.length ?? 0) < 1_600) expect(block.text).toBe('')
      if (block.revealing) expect(reduction.blocks).toHaveLength(1)
      if (!reduction.revealPending) {
        expect(reduction.blocks.map(block => block.kind)).toEqual(['assistant', 'tool', 'assistant'])
        expect(block.text).toBe('answer-'.repeat(200))
        return
      }
    }
    throw new Error('stream did not drain')
  })

  it('keeps the current prefix and queued answer across durable replacement', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const renderer = new TranscriptRenderer(options)
    const reasoning = 'think-'.repeat(200)
    const text = 'answer-'.repeat(200)
    renderer.set([chunk('reasoning-delta', reasoning), chunk('text-delta', text, 1, 2)], [])
    const before = output(renderer)
    expect(before).not.toContain('answer-')
    renderer.set([message([{ type: 'reasoning', text: reasoning }, { type: 'text', text }])], [])
    expect(output(renderer)).toContain('think-'.repeat(8))
    expect(output(renderer)).not.toContain('answer-')
    for (let frame = 0; frame < 130; frame += 1) {
      vi.setSystemTime(2_000 + frame * 33)
      renderer.setEntries([message([{ type: 'reasoning', text: reasoning }, { type: 'text', text }])])
    }
    expect(renderer.liveRevealPending).toBe(false)
    expect(output(renderer)).toContain('answer-')
  })

  it.each([
    { type: 'reasoning', mode: 'detailed' },
    { type: 'reasoning', mode: 'compact' },
    { type: 'text', mode: 'detailed' },
    { type: 'text', mode: 'hidden' },
  ] as const)('does not rewind displayed $type steps in $mode mode when a later step settles', ({ type, mode }) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: mode })
    renderer.set([chunk(type + '-delta', 'FIRST')], [])
    const first = message([{ type, text: 'FIRST' }], 1)
    const call = event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 2)
    const result = event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'OK' }] } }, 3)
    renderer.set([first, call, result], [])
    vi.setSystemTime(1_200)
    const second = chunk(type + '-delta', 'SECOND')
    Object.assign(second.event.data, { step: 2 })
    renderer.set([first, call, result, second], [])
    const before = output(renderer)
    expect(before).toContain('SECOND')
    vi.setSystemTime(1_400)
    renderer.set([first, call, result, event('assistant/message', {
      turn: 1, step: 2, message: { content: [{ type, text: 'SECOND' }] }, stream: [],
    }, 4)], [])
    expect(output(renderer) === before).toBe(true)
    expect(renderer.liveRevealPending).toBe(false)
  })

  it('tracks a burst that settles before any frame is painted', () => {
    const renderer = new TranscriptRenderer(options)
    const reasoning = 'think-'.repeat(200)
    renderer.track(chunk('reasoning-delta', reasoning))
    renderer.track(chunk('text-delta', 'ANSWER', 1, 2))
    renderer.set([message([{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ANSWER' }])], [])
    expect(output(renderer)).not.toContain('ANSWER')
    expect(output(renderer)).toContain('think-')
    expect(renderer.liveRevealPending).toBe(true)
  })

  it('keeps an explicitly open thinking block ahead of later text until block-end', () => {
    const renderer = new TranscriptRenderer(options)
    const start = chunk('block-start', '')
    if (start.type !== 'live') throw new Error('expected live entry')
    Object.assign(start.event.data, { chunk: { type: 'block-start', blockType: 'reasoning', index: 0 } })
    const entries = [start, chunk('text-delta', 'ANSWER', 1, 2)]
    renderer.set(entries, [])
    expect(output(renderer)).toContain('thinking …')
    expect(output(renderer)).not.toContain('ANSWER')
    const end = chunk('block-end', '')
    if (end.type !== 'live') throw new Error('expected live entry')
    Object.assign(end.event.data, { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'THOUGHT' } } })
    entries.push(end)
    for (let frame = 0; frame < 4; frame += 1) renderer.set(entries, [])
    const text = output(renderer)
    expect(text.indexOf('THOUGHT')).toBeLessThan(text.indexOf('ANSWER'))
    expect(text).toContain('ANSWER')
  })

  it('preserves alternating reasoning and text parts, including after settlement', () => {
    const renderer = new TranscriptRenderer(options)
    const parts = [
      { type: 'text', text: 'INTRO' },
      { type: 'reasoning', text: 'THOUGHT A' },
      { type: 'text', text: 'MIDDLE' },
      { type: 'reasoning', text: 'THOUGHT B' },
      { type: 'text', text: 'FINAL' },
    ]
    const entries = parts.map((part, index) => chunk(part.type === 'text' ? 'text-delta' : 'reasoning-delta', part.text, index, index + 1))
    for (let frame = 0; frame < 10; frame += 1) renderer.set(entries, [])
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

  it('keeps a fast retry paced when it settles before the next paint', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([chunk('text-delta', 'FAILED '.repeat(100))], [])
    const failed = event('assistant/attempt', { turn: 1, step: 1, stream: [] }, 2)
    renderer.track(failed)
    const retried = chunk('text-delta', 'RETRY '.repeat(200))
    renderer.track(retried)
    renderer.set([failed, message([{ type: 'text', text: 'RETRY '.repeat(200) }], 3)], [])
    expect(renderer.liveRevealPending).toBe(true)
    expect(output(renderer)).toContain('RETRY')
    expect(output(renderer)).not.toContain('RETRY '.repeat(8))
  })

  it('does not animate reopened history or leak progress to another session', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([chunk('text-delta', 'x'.repeat(1_200))], [])
    expect(renderer.liveRevealPending).toBe(true)
    renderer.clear()
    renderer.set([message([{ type: 'text', text: 'HISTORY ' + 'y'.repeat(1_200) }])], [])
    expect(renderer.liveRevealPending).toBe(false)
    expect(output(renderer)).toContain('HISTORY')
    expect(output(renderer)).toContain('y'.repeat(100))
  })

  it('allows new user input and failures to bypass a reveal without exposing the intervening tool', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      chunk('reasoning-delta', 'x'.repeat(1_200)),
      event('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 2),
      event('turn/end', { reason: { kind: 'aborted' } }, 3),
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'NEW QUESTION' }] }, 4),
    ], [])
    const text = output(renderer)
    expect(text).toContain('Turn cancelled')
    expect(text).toContain('NEW QUESTION')
    expect(text).not.toContain('⚙ read')
  })

  it('holds the next step behind a tool waiting for the final visible frame grace', () => {
    const reducer = createTranscriptReducer({ ...options, revealProgress: new Map() })
    reducer.append([
      chunk('reasoning-delta', 'THOUGHT'),
      event('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 2),
      event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'NEXT' }] } }, 3),
    ])
    expect(reducer.reduce(10_000).blocks.map(block => block.kind)).toEqual(['assistant'])
    expect(reducer.reduce(10_100).blocks.map(block => block.kind)).toEqual(['assistant'])
    expect(reducer.reduce(10_200).blocks.map(block => block.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('does not hold the answer behind hidden thinking', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'hidden' })
    renderer.set([chunk('reasoning-delta', 'x'.repeat(1_200)), chunk('text-delta', 'ANSWER', 1, 2)], [])
    expect(output(renderer)).toContain('ANSWER')
    expect(renderer.liveRevealPending).toBe(false)
  })

  it('reveals all detailed thinking before the answer without a preview cutoff', () => {
    const renderer = new TranscriptRenderer(options)
    const reasoning = 'x'.repeat(20_000) + 'THINKING-END'
    const entries = [chunk('reasoning-delta', reasoning), chunk('text-delta', 'ANSWER', 1, 2)]
    for (let frame = 0; frame < 130; frame += 1) renderer.set(entries, [])
    expect(renderer.liveRevealPending).toBe(true)
    expect(output(renderer)).not.toContain('ANSWER')
    const settled = [message([{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ANSWER' }])]
    renderer.set(settled, [])
    expect(renderer.liveRevealPending).toBe(true)
    expect(output(renderer)).not.toContain('ANSWER')
    for (let frame = 130; frame < 850 && renderer.liveRevealPending; frame += 1) renderer.set(settled, [])
    expect(renderer.liveRevealPending).toBe(false)
    const text = output(renderer)
    expect(text.includes('THINKING-END')).toBe(true)
    expect(text).toContain('ANSWER')
    expect(text).not.toContain('omitted')
    expect(text).not.toContain('truncated')
  })

  it.each([false, true])('renders full detailed thinking with ordered content=%s', ordered => {
    const reasoning = 'line\n'.repeat(1_000) + 'FULL-THINKING-END'
    const component = new AssistantMessage({ kind: 'assistant', reasoning, text: 'ANSWER', live: false,
      ...(ordered ? { content: [{ type: 'reasoning' as const, text: reasoning }, { type: 'text' as const, text: 'ANSWER' }] } : {}),
    }, options)
    const text = component.render(120).join('\n')
    expect(text.includes('FULL-THINKING-END')).toBe(true)
    expect(text).not.toContain('omitted')
    expect(text).not.toContain('truncated')
  })

  it('keeps compact and hidden thinking unchanged and restores full detailed history', () => {
    const renderer = new TranscriptRenderer(options)
    const reasoning = 'COMPACT-FIRST-LINE\n' + 'detail\n'.repeat(1_000) + 'HISTORY-THINKING-END'
    renderer.set([message([{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'ANSWER' }])], [])
    expect(output(renderer).includes('HISTORY-THINKING-END')).toBe(true)
    renderer.setDisplayModes('compact', 'detailed')
    expect(output(renderer)).toContain('thinking · COMPACT-FIRST-LINE')
    expect(output(renderer)).not.toContain('HISTORY-THINKING-END')
    renderer.setDisplayModes('hidden', 'detailed')
    expect(output(renderer)).not.toContain('COMPACT-FIRST-LINE')
    expect(output(renderer)).toContain('ANSWER')
    renderer.setDisplayModes('detailed', 'detailed')
    expect(output(renderer).includes('HISTORY-THINKING-END')).toBe(true)
    expect(output(renderer)).not.toContain('omitted')
  })
})

describe('incremental transcript folding', () => {
  it('never rereads accumulated chunks on reveal frames or appended suffixes', () => {
    const renderer = new TranscriptRenderer(options)
    let reads = 0
    const entries: TranscriptEntry[] = []
    for (let index = 0; index < 10_000; index += 1) {
      const entry = chunk('text-delta', 'x', 0, index)
      if (entry.type !== 'live') throw new Error('expected live chunk')
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

  it('replays replacements but not an unchanged suffix after window trimming', () => {
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

  it('keeps completed thinking components and their line cache while the answer grows', () => {
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

describe('Unicode reveal boundaries', () => {
  it.each(['e\u0301', '👩‍💻', '🇨🇳', '🧠'])('does not split %s in live text', grapheme => {
    const text = grapheme.repeat(80)
    const state = { start: 0, visible: 0 }
    let shown = ''
    for (let frame = 0; frame < 200; frame += 1) {
      const next = revealStreamText(text, state, frame * 500)
      expect(next.text.length % grapheme.length).toBe(0)
      expect(next.text.startsWith(shown)).toBe(true)
      shown = next.text
      if (!next.pending) break
    }
    expect(shown).toBe(text)
  })

  it('holds a surrogate split in a token-sized delta for the next frame', () => {
    const state = { start: 0, visible: 0 }
    expect(revealStreamText('a' + String.fromCharCode(0xD83D), state, 0)).toEqual({ text: 'a', pending: true })
    expect(revealStreamText('a😀', state, 33)).toEqual({ text: 'a😀', pending: false })
  })

  it('extends a cached grapheme prefix without repeating its beginning', () => {
    const text = 'abcdef👩‍💻ghijkl'
    expect(clipGraphemes(text, 3)).toBe('abc\n… [10 chars omitted]')
    expect(clipGraphemes(text, 8)).toBe('abcdef👩‍💻g\n… [5 chars omitted]')
  })
})
