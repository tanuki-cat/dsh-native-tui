import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import type { TranscriptEntry } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 600, palette, markdown: markdownTheme(palette) }
const live = (chunk: StreamChunk, seq: number): TranscriptEntry => ({
  type: 'live',
  event: { type: 'assistant/live-chunk', seq, time: 1, data: { attemptId: 'a', turn: 1, step: 2, chunk } },
})
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 1 } as SessionEvent,
})
const output = (renderer: TranscriptRenderer): string => renderer.container.render(120).join('\n')
const toolCall = event('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'run_code', arguments: '{}' }, 10)

const toolChunks: readonly (readonly StreamChunk[])[] = [
  [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'c1' as never, name: 'run_code', argumentsDelta: '{}' },
  ],
  [{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1' as never, name: 'run_code', arguments: '{}' } }],
  [{ type: 'tool-call-delta', index: 1, id: 'c1' as never, name: 'run_code', argumentsDelta: '{}' }],
  [],
]

describe.each(['detailed', 'compact', 'hidden'] as const)('empty reasoning in %s mode', thinkingDisplay => {
  it.each(toolChunks.map((chunks, index) => ({ chunks, index })))('does not flash thinking before tool path $index', ({ chunks }) => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay, runCodeDisplay: 'compact' })
    const entries = [live({ type: 'block-start', index: 0, blockType: 'reasoning' }, 1)]
    renderer.set(entries, [])
    expect(output(renderer)).toBe('')

    for (const [index, chunk] of chunks.entries()) {
      entries.push(live(chunk, index + 2))
      renderer.set(entries, [])
      expect(output(renderer)).toBe('')
    }

    entries.push(toolCall)
    renderer.set(entries, [])
    expect(output(renderer)).toContain('⚙ run_code')
    expect(output(renderer)).toContain('running')
    expect(output(renderer)).not.toContain('thinking')
    expect(output(renderer)).not.toContain('◆ assistant')
  })

  it('keeps an empty or whitespace-only reasoning block invisible through settlement', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay })
    const entries = [live({ type: 'block-start', index: 0, blockType: 'reasoning' }, 1)]
    for (const chunk of [
      { type: 'reasoning-delta', index: 0, text: '' },
      { type: 'reasoning-delta', index: 0, text: ' \n' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: ' \n' } },
    ] as const) {
      entries.push(live(chunk, entries.length + 1))
      renderer.set(entries, [])
      expect(output(renderer)).toBe('')
    }
    entries.push(event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: ' \n' }] } }, 10))
    renderer.set(entries, [])
    expect(output(renderer)).toBe('')
  })
})

describe.each(['detailed', 'compact'] as const)('actual reasoning in %s mode', thinkingDisplay => {
  it('shows thinking only after content arrives and preserves it beside the tool', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay, runCodeDisplay: 'compact' })
    const entries = [live({ type: 'block-start', index: 0, blockType: 'reasoning' }, 1)]
    renderer.set(entries, [])
    expect(output(renderer)).toBe('')

    entries.push(live({ type: 'reasoning-delta', index: 0, text: 'ACTUAL THOUGHT' }, 2))
    renderer.set(entries, [])
    expect(output(renderer)).toContain('thinking')
    expect(output(renderer)).toContain('ACTUAL THOUGHT')

    entries.push(live({ type: 'block-start', index: 1, blockType: 'tool-call' }, 3), toolCall)
    renderer.set(entries, [])
    expect(output(renderer)).toContain('ACTUAL THOUGHT')
    expect(output(renderer)).toContain('⚙ run_code')
  })
})
