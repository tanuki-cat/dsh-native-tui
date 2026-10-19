import { describe, expect, it } from 'vitest'
import { Spacer } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Rule } from '../src/ui/rule.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { contentText, formatToolArguments, nextStreamInterval, reduceTranscript, reduceTranscriptWindow, sameTranscriptBlock, STREAM_MIN_INTERVAL_MS, TranscriptRenderer, WAIT_ROW_DELAY_MS, waitingText, waitingVisible, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'

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

function liveChunk(seq: number, turn: number, step: number, chunk: unknown): TranscriptEntry {
  return {
    type: 'live',
    event: { type: 'assistant/live-chunk', seq, time: 0, data: { attemptId: 'a', turn, step, chunk } } as never,
  }
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

  it('keeps the settled content of a failed attempt instead of dropping it', () => {
    // A truncated model response settles as assistant/attempt: the compact
    // stream is the only record of what streamed before the failure.
    const stream = [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['weighed the options '] },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighed the options' } } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Response incomplete: length' } } } },
    ]
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'reasoning-delta', text: 'weighed the options' }),
      durable('assistant/attempt', { turn: 1, step: 1, stream }, 2),
      durable('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Response incomplete: length' } } }, 3),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: '', reasoning: 'weighed the options', live: false })
    expect(blocks[1]).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  it('starts a fresh live block when a retry of the same step streams after an attempt', () => {
    const stream = [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated' } } } },
    ]
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'text-delta', text: 'draft one' }),
      durable('assistant/attempt', { turn: 1, step: 1, stream }, 2),
      liveChunk(3, 1, 1, { type: 'text-delta', text: 'retry streaming' }),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'partial', live: false })
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: 'retry streaming', live: true })
  })

  it('reports the oldest entry a retained row still needs', () => {
    const entries: TranscriptEntry[] = [
      durable('turn/start', { turn: 1 }, 1),
      durable('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, 2),
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'yo' }] } }, 3),
    ]
    const reduction = reduceTranscriptWindow(entries, options)
    expect(reduction.retainedFrom).toBe(1)
    expect(reduction.blocks[0]).toMatchObject({ kind: 'user', text: 'hi' })
  })

  it('keeps a tool call entry while its result row is retained', () => {
    const entries: TranscriptEntry[] = [
      durable('turn/start', { turn: 1 }, 1),
      durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, 2),
      durable('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'out' }] } }, 3),
    ]
    const reduction = reduceTranscriptWindow(entries, options)
    // The row is created by the call entry, so the result alone must not be kept.
    expect(reduction.retainedFrom).toBe(1)
    expect(reduceTranscript(entries.slice(reduction.retainedFrom), options)).toEqual(reduction.blocks)
  })

  it('reports the first retained row once the window is capped', () => {
    const entries: TranscriptEntry[] = [1, 2, 3].map(seq =>
      durable('user/message', { content: [{ type: 'text', text: 'm' + String(seq) }], source: { kind: 'user' } }, seq))
    const reduction = reduceTranscriptWindow(entries, { ...options, maxEntries: 2 })
    // The synthesized hidden-count notice needs no entry of its own.
    expect(reduction.blocks[0]).toMatchObject({ kind: 'notice' })
    expect(reduction.retainedFrom).toBe(1)
  })

  it('ignores an unusable attempt stream', () => {
    const entries: TranscriptEntry[] = [durable('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'unknown' } }] }, 1)]
    expect(reduceTranscript(entries, options)).toHaveLength(0)
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

describe('waitingText', () => {
  it('counts the seconds the request has been in flight', () => {
    expect(waitingText(1_000, undefined, 1_000)).toBe('waiting for API response · 0s')
    expect(waitingText(1_000, undefined, 4_400)).toBe('waiting for API response · 3s')
  })

  it('names the automatic retry so the reader does not retry by hand', () => {
    expect(waitingText(1_000, { retry: 2, maxRetries: 5, code: 'TRANSPORT' }, 6_000))
      .toBe('waiting for API response · 5s  ·  retry 2/5 after TRANSPORT (automatic)')
  })

  it('never counts backwards when the clock jumps', () => {
    expect(waitingText(5_000, undefined, 1_000)).toBe('waiting for API response · 0s')
  })
})

describe('waitingVisible', () => {
  it('holds the row back through the flash window', () => {
    expect(waitingVisible(0, undefined, WAIT_ROW_DELAY_MS - 1)).toBe(false)
    expect(waitingVisible(0, undefined, WAIT_ROW_DELAY_MS)).toBe(true)
  })

  it('shows a scheduled retry immediately', () => {
    // The reader already sat through the failed attempt, so the replay is news.
    expect(waitingVisible(0, { retry: 1, maxRetries: 5, code: 'TRANSPORT' }, 1)).toBe(true)
  })
})

describe('nextStreamInterval', () => {
  it('holds the streaming floor for a cheap frame', () => {
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 0)).toBe(STREAM_MIN_INTERVAL_MS)
  })

  it('widens the interval for an over-budget frame', () => {
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 40)).toBe(50)
  })

  it('narrows back toward the floor after a cheap frame', () => {
    expect(nextStreamInterval(100, 1)).toBe(75)
  })

  it('clamps the widened interval', () => {
    let interval = STREAM_MIN_INTERVAL_MS
    for (let frame = 0; frame < 20; frame += 1) interval = nextStreamInterval(interval, 40)
    expect(interval).toBe(100)
  })
})

describe('TranscriptRenderer component reuse', () => {
  const user = (seq: number, text: string): TranscriptEntry =>
    durable('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
  const assistant = (seq: number, text: string): TranscriptEntry =>
    durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } }, seq)
  /** Rendered block components in order, without the separator rows between them. */
  const rows = (renderer: TranscriptRenderer): unknown[] =>
    renderer.container.children.filter(child => !(child instanceof Spacer) && !(child instanceof Rule))

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

  it('reuses surviving block components when a full window drops its oldest row', () => {
    const renderer = new TranscriptRenderer({ ...options, maxEntries: 2 })
    const first = [user(1, 'a'), user(2, 'b'), user(3, 'c')]
    renderer.set(first, [])
    const before = rows(renderer)
    // The window is full, so this drops user 1, keeps user 3, and shifts every
    // index. Reuse must follow the block, not its position.
    renderer.set([...first, user(4, 'd')], [])
    const after = rows(renderer)
    expect(after).toHaveLength(before.length)
    expect(after[1]).toBe(before[2])
  })

  it('stays bounded when the caller drops the prefix the window no longer needs', () => {
    const renderer = new TranscriptRenderer({ ...options, maxEntries: 4 })
    let entries: TranscriptEntry[] = []
    for (let seq = 1; seq <= 40; seq += 1) {
      entries.push(user(seq, 'm' + String(seq)))
      renderer.set(entries, [])
      if (renderer.retainedFrom > 0) entries = entries.slice(renderer.retainedFrom)
    }
    expect(entries.length).toBeLessThanOrEqual(8)
    expect(renderer.container.render(80).join('\n')).toContain('m40')
  })

  it('renders the transient model-wait row after the transcript', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'question')], [{ kind: 'waiting', text: waitingText(0, undefined, 3_000) }])
    const output = renderer.container.render(80).join('\n')
    expect(output).toContain('⟳ waiting for API response · 3s')
    // The row is transient, so it leaves no cached component behind.
    expect(renderer.container.children).toHaveLength(3)
  })

  it('reports the trailing live block size for frame pacing', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([liveChunk(1, 1, 1, { type: 'text-delta', text: 'hello' })], [])
    expect(renderer.liveContentLength).toBe(5)
    renderer.set([durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } }, 2)], [])
    expect(renderer.liveContentLength).toBe(0)
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

