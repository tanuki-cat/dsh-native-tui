import { describe, expect, it } from 'vitest'
import { AssistantStream } from '../src/ui/transcript-stream.js'
import { createTranscriptReducer, type TranscriptEntry } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { showReasoning: true, thinkingDisplay: 'detailed' as const, maxEntries: 600, palette, markdown: markdownTheme(palette) }
const compactOptions = { ...options, thinkingDisplay: 'compact' as const }

const chunkOf = (value: unknown): never => value as never

describe('AssistantStream tool-call placeholders', () => {
  it('drops the thinking placeholder once a tool call starts', () => {
    // A step whose first block is a tool call sends block-start{tool-call}
    // without any reasoning/text delta. The reasoning placeholder must not
    // survive that, or the row claims the model is still thinking while it is
    // actually dispatching a tool.
    const stream = new AssistantStream('1:1', options)
    stream.append(chunkOf({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    expect(stream.project()).toMatchObject({ starting: true })

    stream.append(chunkOf({ type: 'block-start', index: 1, blockType: 'tool-call' }))
    expect(stream.project()).not.toHaveProperty('starting')
  })

  it('drops the placeholder for a tool-call delta without a block-start', () => {
    const stream = new AssistantStream('1:1', options)
    stream.append(chunkOf({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    stream.append(chunkOf({ type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{"file_path":' }))
    expect(stream.project()).not.toHaveProperty('starting')
  })

  it('drops the placeholder when the attempt settles without content', () => {
    const stream = new AssistantStream('1:1', options)
    stream.append(chunkOf({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    stream.settle([], 5)
    expect(stream.project()).not.toHaveProperty('starting')
  })

  it('keeps compact thinking · … only while nothing else arrived', () => {
    const stream = new AssistantStream('1:1', compactOptions)
    stream.append(chunkOf({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    expect(stream.project()).toMatchObject({ starting: true })
    stream.append(chunkOf({ type: 'block-start', index: 1, blockType: 'tool-call' }))
    expect(stream.project()).not.toHaveProperty('starting')
  })

  it('drops the placeholder through the reducer so no empty row survives', () => {
    // The card must disappear entirely once the tool call replaces it, not
    // linger as a bare `◆ assistant` row above the tool.
    const reducer = createTranscriptReducer({ ...options, maxEntries: 600 })
    const live = (chunk: unknown, seq: number): TranscriptEntry => ({
      type: 'live',
      event: { type: 'assistant/live-chunk', seq, time: 1, data: { attemptId: 'a', turn: 1, step: 2, chunk } } as never,
    })
    reducer.append([
      live({ type: 'block-start', index: 0, blockType: 'reasoning' }, 1),
      live({ type: 'block-start', index: 1, blockType: 'tool-call' }, 2),
      live({ type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{"command":"ls"}' }, 3),
    ])
    expect(reducer.reduce().blocks.filter(block => block.kind === 'assistant')).toEqual([])
  })
})
