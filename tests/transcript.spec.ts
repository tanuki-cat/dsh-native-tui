import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { contentText, formatToolArguments, reduceTranscript, sameTranscriptBlock, TranscriptRenderer, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'

const palette = createPalette('plain')
const options = {
  showReasoning: true,
  maxEntries: 100,
  palette,
  markdown: markdownTheme(palette),
}

function durable(type: string, data: unknown, seq = 0): TranscriptEntry {
  return { type: 'event', event: { type, seq, time: 0, data } as unknown as SessionEvent }
}

describe('reduceTranscript', () => {
  it('renders user, assistant, and completed tool rows', () => {
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hi there' }] } }),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'file.txt' }], isError: false },
        meta: { diffs: [{ path: 'file.txt', oldText: 'old', newText: 'new' }] },
      }),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hello' })
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: 'hi there', live: false })
    expect(blocks[2]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      pending: false,
      args: '{"command":"ls"}',
      result: 'file.txt',
      diffs: [{ path: 'file.txt', oldText: 'old', newText: 'new' }],
    })
  })

  it('folds live chunks into one assistant row', () => {
    const entries: TranscriptEntry[] = [
      { type: 'live', event: { type: 'assistant/live-chunk', seq: 1, time: 0, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } } } },
      { type: 'live', event: { type: 'assistant/live-chunk', seq: 2, time: 0, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'lo' } } } },
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello', live: true })
  })

  it('hides live rows once the durable assistant message settles the step', () => {
    const entries: TranscriptEntry[] = [
      { type: 'live', event: { type: 'assistant/live-chunk', seq: 1, time: 0, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'draft' } } } },
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } }),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'final', live: false })
  })

  it('labels file and image blocks', () => {
    expect(contentText([
      { type: 'file', attachment: { name: 'notes.txt' } },
      { type: 'image', attachment: { name: 'pixel.png', mediaType: 'image/png' } },
    ] as never)).toBe('[file notes.txt]' + String.fromCharCode(10) + '[image pixel.png]')
  })

  it('hides tool-call content and formats JSON arguments', () => {
    expect(contentText([
      { type: 'tool-call', id: 'call-1', name: 'run', arguments: '{}' },
      { type: 'text', text: 'visible' },
    ] as never)).toBe('visible')
    const formatted = formatToolArguments(JSON.stringify({ code: 'const a = 1\nconst b = 2', timeoutMs: 60000 }))
    expect(formatted).toContain('code:')
    expect(formatted).toContain('  const a = 1')
    expect(formatted).toContain('timeoutMs: 60000')
  })

  it('renders compaction lifecycle and pruned tool output', () => {
    const entries: TranscriptEntry[] = [
      durable('compaction/start', { compactionId: 'c1', turn: 1 }, 1),
      durable('compaction/summary', {
        compactionId: 'c1',
        summary: [{ type: 'text', text: 'condensed checkpoint' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 1200,
        provider: 'mock',
        model: 'mock',
      }, 2),
      durable('compaction/end', { compactionId: 'c1', turn: 1 }, 3),
      durable('compaction/prune', { shadowedSeqs: [4, 5], shadowedTokenCount: 640 }, 4),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({
      kind: 'compaction',
      state: 'done',
      shadowedItems: 3,
      shadowedTokens: 1200,
      summary: 'condensed checkpoint',
    })
    expect(blocks[1]).toMatchObject({ kind: 'notice', tone: 'info', text: 'Tool output pruned · 2 item(s) · ~640 tokens' })
    const renderer = new TranscriptRenderer(options)
    renderer.set(entries, [])
    const output = renderer.container.render(80).join('\n')
    expect(output).toContain('Context compacted')
    expect(output).toContain('3 item(s)')
    expect(output).toContain('condensed checkpoint')
    expect(output).toContain('Tool output pruned')
  })

  it('supports compact and hidden reasoning/run_code blocks', () => {
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'calc' }], source: { kind: 'user' } }, 1),
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [
          { type: 'reasoning', text: 'first thought\nsecond thought' },
          { type: 'text', text: 'answer' },
        ] },
      }, 2),
      durable('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'run_code',
        arguments: JSON.stringify({ description: 'Press AC', code: 'long code body' }),
      }, 3),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'long result body' }], isError: false },
      }, 4),
    ]
    const compactOptions = { ...options, thinkingDisplay: 'compact' as const, runCodeDisplay: 'compact' as const }
    const compact = reduceTranscript(entries, compactOptions)
    expect(compact.find(block => block.kind === 'tool')).toMatchObject({ kind: 'tool', name: 'run_code', pending: false })
    const renderer = new TranscriptRenderer(compactOptions)
    renderer.set(entries, [])
    const compactOutput = renderer.container.render(100).join('\n')
    expect(compactOutput).toContain('thinking · first thought')
    expect(compactOutput).toContain('⚙ run_code')
    expect(compactOutput).toContain('Press AC')
    expect(compactOutput).not.toContain('long code body')
    expect(compactOutput).toContain('long result body')

    const hiddenOptions = { ...options, thinkingDisplay: 'hidden' as const, runCodeDisplay: 'hidden' as const }
    const hidden = reduceTranscript(entries, hiddenOptions)
    const assistant = hidden.find(block => block.kind === 'assistant')
    expect(assistant).not.toHaveProperty('reasoning')
    expect(hidden.some(block => block.kind === 'tool')).toBe(false)
  })

  it('applies code-execution density to shell tool cards', () => {
    const shellEntries = (callId: string, name: string, args: unknown): TranscriptEntry[] => [
      durable('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, 1),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId }, content: [{ type: 'text', text: 'file.txt\nsecond line' }], isError: false },
      }, 2),
    ]
    for (const name of ['bash', 'pwsh']) {
      const entries = shellEntries('call-' + name, name, { description: 'List files', command: 'ls -la' })
      const renderer = new TranscriptRenderer({ ...options, runCodeDisplay: 'compact' })
      renderer.set(entries, [])
      const output = renderer.container.render(100).join('\n')
      expect(output).toContain('⚙ ' + name)
      expect(output).toContain('List files')
      expect(output).toContain('file.txt')
      expect(output).not.toContain('├ args')
      expect(output).not.toContain('second line')

      const hiddenRenderer = new TranscriptRenderer({ ...options, runCodeDisplay: 'hidden' })
      hiddenRenderer.set(entries, [])
      const hiddenOutput = hiddenRenderer.container.render(100).join('\n')
      expect(hiddenOutput).not.toContain('⚙ ' + name)
      expect(hiddenOutput).not.toContain('file.txt')
    }

    const renderer = new TranscriptRenderer({ ...options, runCodeDisplay: 'compact' })
    renderer.set(shellEntries('call-command', 'bash', { command: 'echo hi' }), [])
    const output = renderer.container.render(100).join('\n')
    expect(output).toContain('echo hi')
  })

  it('marks turn failures and caps old rows', () => {
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }),
      durable('user/message', { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }),
      durable('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_FAIL', message: 'boom' } } }),
    ]
    const blocks = reduceTranscript(entries, { ...options, maxEntries: 2 })
    expect(blocks[0]).toMatchObject({ kind: 'notice', tone: 'info' })
    expect(blocks.some(block => block.kind === 'notice' && block.tone === 'error')).toBe(true)
  })
})

describe('TranscriptRenderer', () => {
  it('rebuilds when display modes change live', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'detailed', runCodeDisplay: 'detailed' })
    const entries: TranscriptEntry[] = [
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [
          { type: 'reasoning', text: 'live thought' },
          { type: 'text', text: 'answer' },
        ] },
      }, 1),
      durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: '{"description":"Press AC"}' }, 2),
      durable('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'done' }], isError: false } }, 3),
    ]
    renderer.set(entries, [])
    expect(renderer.container.render(100).join('\n')).toContain('live thought')
    renderer.setDisplayModes('hidden', 'hidden')
    const hidden = renderer.container.render(100).join('\n')
    expect(hidden).not.toContain('live thought')
    expect(hidden).not.toContain('run_code')
    renderer.setDisplayModes('compact', 'compact')
    const compact = renderer.container.render(100).join('\n')
    expect(compact).toContain('thinking · live thought')
    expect(compact).toContain('Press AC')
  })

  it('rebuilds cached components when display modes change between detailed and compact', () => {
    const entries: TranscriptEntry[] = [
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [
          { type: 'reasoning', text: 'first thought\nsecond thought' },
          { type: 'text', text: 'answer' },
        ] },
      }, 1),
      durable('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'run_code',
        arguments: JSON.stringify({ description: 'Press AC', code: 'long code body' }),
      }, 2),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'long result body' }], isError: false },
      }, 3),
    ]
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'detailed', runCodeDisplay: 'detailed' })
    renderer.set(entries, [])
    const detailed = renderer.container.render(100).join('\n')
    expect(detailed).toContain('second thought')
    expect(detailed).toContain('├ args')
    expect(detailed).toContain('long code body')

    renderer.setDisplayModes('detailed', 'compact')
    const compactRunCode = renderer.container.render(100).join('\n')
    expect(compactRunCode).not.toContain('├ args')
    expect(compactRunCode).toContain('⚙ run_code')
    expect(compactRunCode).toContain('Press AC')
    expect(compactRunCode).not.toContain('long code body')

    renderer.setDisplayModes('compact', 'detailed')
    const compactThinking = renderer.container.render(100).join('\n')
    expect(compactThinking).toContain('thinking · first thought')
    expect(compactThinking).not.toContain('second thought')
    expect(compactThinking).toContain('├ args')
    expect(compactThinking).toContain('long code body')
  })

  it('labels blocks and keeps reasoning with the answer', () => {
    const renderer = new TranscriptRenderer(options)
    const blocks: TranscriptBlock[] = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'final answer', reasoning: 'inspect the request', live: false },
      { kind: 'tool', callId: 'call-1', name: 'read', pending: false, isError: false, args: '{"path":"a.ts"}', result: 'export {}' },
    ]
    renderer.set([], blocks)
    const output = renderer.container.render(80).join('\n')
    expect(output).toContain('▌ You')
    expect(output).toContain('◆ assistant')
    expect(output).toContain('thinking')
    expect(output).toContain('inspect the request')
    expect(output).toContain('final answer')
    expect(output).toContain('├ args')
    expect(output).toContain('├ result')
  })
})

describe('TranscriptRenderer notice ordering', () => {
  it('places local notices at their durable sequence', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }, 2),
    ], [
      { kind: 'notice', tone: 'info', text: 'before turn', afterSeq: 0 },
      { kind: 'notice', tone: 'info', text: 'after turn', afterSeq: 2 },
    ])
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('before turn')).toBeLessThan(output.indexOf('▌ You'))
    expect(output.indexOf('after turn')).toBeGreaterThan(output.indexOf('answer'))
  })
})

describe('sameTranscriptBlock', () => {
  it('accepts an unchanged block', () => {
    expect(sameTranscriptBlock({ kind: 'user', text: 'hello' }, { kind: 'user', text: 'hello' })).toBe(true)
  })

  it('rejects a changed kind, text, or key set', () => {
    expect(sameTranscriptBlock({ kind: 'user', text: 'a' }, { kind: 'assistant', text: 'a', live: false })).toBe(false)
    expect(sameTranscriptBlock({ kind: 'user', text: 'a' }, { kind: 'user', text: 'b' })).toBe(false)
    expect(sameTranscriptBlock(
      { kind: 'assistant', text: 'a', live: true },
      { kind: 'assistant', text: 'a', live: true, reasoning: 'r' },
    )).toBe(false)
  })

  it('compares arrays by length and element identity', () => {
    const diff = { path: 'file.txt', oldText: 'old', newText: 'new' }
    const base: TranscriptBlock = { kind: 'tool', callId: 'c1', name: 'edit', args: '{}', pending: false, diffs: [diff] }
    expect(sameTranscriptBlock(base, { ...base, diffs: [diff] })).toBe(true)
    expect(sameTranscriptBlock(base, { ...base, diffs: [] })).toBe(false)
    expect(sameTranscriptBlock(base, { ...base, diffs: [{ ...diff, newText: 'changed' }] })).toBe(false)
  })
})

describe('TranscriptRenderer component reuse', () => {
  const user = (seq: number, text: string): TranscriptEntry =>
    durable('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
  const assistant = (seq: number, text: string): TranscriptEntry =>
    durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } }, seq)

  it('reuses unchanged block components when nothing changed', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [user(1, 'hello'), assistant(2, 'world')]
    renderer.set(entries, [])
    const before = [...renderer.container.children]
    renderer.set(entries, [])
    const after = [...renderer.container.children]
    expect(after).toHaveLength(before.length)
    // Index 0 is the user block and the last child the assistant block; the
    // separating Spacer/Rule rows are cheap and intentionally rebuilt each time.
    expect(after[0]).toBe(before[0])
    expect(after[after.length - 1]).toBe(before[before.length - 1])
  })

  it('rebuilds only the block whose text changed', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'hello'), assistant(2, 'first')], [])
    const before = [...renderer.container.children]
    renderer.set([user(1, 'hello'), assistant(2, 'second')], [])
    const after = [...renderer.container.children]
    expect(after[0]).toBe(before[0])
    expect(after[after.length - 1]).not.toBe(before[before.length - 1])
  })

  it('rebuilds after clear() resets the reuse window', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [user(1, 'hello')]
    renderer.set(entries, [])
    const before = renderer.container.children[0]
    renderer.clear()
    renderer.set(entries, [])
    expect(renderer.container.children[0]).not.toBe(before)
  })
})

