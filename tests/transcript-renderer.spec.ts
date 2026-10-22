import { describe, expect, it } from 'vitest'
import { Spacer } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Rule } from '../src/ui/rule.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { streamingRowKey, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { sameTranscriptBlock, TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { waitingText } from '../src/ui/waiting.js'

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

function liveChunk(seq: number, turn: number, step: number, chunk: unknown, time = 0): TranscriptEntry {
  return {
    type: 'live',
    event: { type: 'assistant/live-chunk', seq, time, data: { attemptId: 'a', turn, step, chunk } } as never,
  }
}

describe('TranscriptRenderer', () => {
  it('marks the first rebuild cold and later frames warm', () => {
    const renderer = new TranscriptRenderer(options)
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
    ]
    renderer.set(entries, [])
    expect(renderer.coldRebuild).toBe(true)
    renderer.set(entries, [])
    expect(renderer.coldRebuild).toBe(false)
  })

  it('keeps unaffected components when only display modes change', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'detailed', runCodeDisplay: 'detailed' })
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }, 2),
    ]
    renderer.set(entries, [])
    const userRow = renderer.container.children[0]
    renderer.setDisplayModes('compact', 'compact')
    expect(renderer.container.children[0]).toBe(userRow)
  })

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
    expect(detailed).toContain('⚙ run_code · Press AC')
    expect(detailed).toContain('│ long code body')
    expect(detailed).not.toContain('├ args')

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
    expect(compactThinking).toContain('⚙ run_code · Press AC')
    expect(compactThinking).toContain('│ long code body')
  })

  it('keeps tool and compaction head rows identical across their lifecycle', () => {
    // Main-screen pi-tui repaints the whole transcript when a row above the
    // viewport changes, so card heads must never encode run state. The state
    // lives on the tail row, which main-screen patches or extends safely.
    const pending = renderTranscriptBlock({ kind: 'tool', callId: 'c1', name: 'read', args: '{}', pending: true }, options)
    const settled = renderTranscriptBlock({ kind: 'tool', callId: 'c1', name: 'read', args: '{}', result: 'ok', pending: false }, options)
    const failed = renderTranscriptBlock({ kind: 'tool', callId: 'c1', name: 'read', args: '{}', result: 'no', isError: true, pending: false }, options)
    const pendingHead = pending.render(80)[0]
    expect(pendingHead).toBe(settled.render(80)[0])
    expect(pendingHead).toBe(failed.render(80)[0])
    expect(pendingHead).not.toContain('running')
    expect(settled.render(80).at(-1)).toContain('done')
    expect(failed.render(80).at(-1)).toContain('error')

    const running = renderTranscriptBlock({ kind: 'compaction', compactionId: 'k', state: 'running', seq: 1 }, options)
    const done = renderTranscriptBlock({ kind: 'compaction', compactionId: 'k', state: 'done', shadowedItems: 1, shadowedTokens: 5, summary: 's', seq: 2 }, options)
    const errored = renderTranscriptBlock({ kind: 'compaction', compactionId: 'k', state: 'error', error: 'x', seq: 3 }, options)
    const runningHead = running.render(80)[0]
    expect(runningHead).toBe(done.render(80)[0])
    expect(runningHead).toBe(errored.render(80)[0])
    expect(runningHead).not.toContain('compacting')
    expect(done.render(80)).toContainEqual(expect.stringContaining('✓ done'))
    expect(errored.render(80)).toContainEqual(expect.stringContaining('✕ failed'))
  })

  it('keeps the assistant head row identical when a live block settles', () => {
    // A head row that changes after it scrolled above the viewport makes
    // main-screen pi-tui clear the screen and the scrollback to repaint the
    // transcript, so the label must not encode the live state.
    const live = renderTranscriptBlock({ kind: 'assistant', text: 'streamed', live: true }, options)
    const settled = renderTranscriptBlock({ kind: 'assistant', text: 'streamed', live: false }, options)
    const liveHead = live.render(80)[0]
    expect(liveHead).toBe(settled.render(80)[0])
    expect(liveHead).not.toContain('streaming')
  })

  it('renders code execution cards from parsed arguments', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c1',
      name: 'run_code',
      pending: false,
      args: JSON.stringify({ description: 'Press AC', code: 'const x = 1\nconsole.log(x)' }),
      result: '1',
    }, options).render(100).join('\n')
    expect(output).toContain('⚙ run_code · Press AC')
    expect(output).toContain('│ const x = 1')
    expect(output).toContain('│ console.log(x)')
    expect(output).toContain('├ result')
    expect(output).toContain('│ 1')
    expect(output).toContain('└ done')
    expect(output).not.toContain('├ args')
  })

  it('renders shell cards with the command and description', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c2',
      name: 'bash',
      pending: false,
      args: JSON.stringify({ command: 'pnpm check', description: 'run repository gate' }),
      result: 'ok',
    }, options).render(100).join('\n')
    expect(output).toContain('⚙ bash · run repository gate')
    expect(output).toContain('│ pnpm check')
    expect(output).toContain('└ done')
  })

  it('shows call options that change what a shell command means', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c5',
      name: 'bash',
      pending: false,
      args: JSON.stringify({
        command: 'pnpm check',
        description: 'run repository gate',
        timeoutMs: 600000,
        workdir: 'packages/client',
        run_in_background: true,
        sandbox_permissions: 'workspace-write',
      }),
    }, options).render(120).join('\n')
    expect(output).toContain('workdir packages/client')
    expect(output).toContain('timeout 600s')
    expect(output).toContain('background')
    expect(output).toContain('sandbox workspace-write')
  })

  it('names a description-less command by its first line', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c6',
      name: 'bash',
      pending: false,
      args: JSON.stringify({ command: 'ls -la' }),
    }, options).render(100).join('\n')
    expect(output).toContain('⚙ bash · ls -la')
    expect(output).toContain('│ ls -la')
  })

  it('shows the run_code timeout in the meta line', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c7',
      name: 'run_code',
      pending: false,
      args: JSON.stringify({ description: 'demo', timeoutMs: 1500, code: 'const x = 1' }),
    }, options).render(100).join('\n')
    expect(output).toContain('timeout 1500ms')
  })

  it('shortens long code lines instead of wrapping them', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c8',
      name: 'run_code',
      pending: false,
      args: JSON.stringify({ description: 'long line', code: 'const long = "' + 'x'.repeat(500) + '"' }),
    }, options).render(120).join('\n')
    expect(output).toContain('long lines shortened')
    expect(output).not.toContain('x'.repeat(200))
  })

  it('caps the result preview', () => {
    const result = Array.from({ length: 15 }, (_, index) => 'result line ' + String(index)).join('\n')
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c9',
      name: 'bash',
      pending: false,
      args: JSON.stringify({ command: 'run', description: 'many lines' }),
      result,
    }, options).render(120).join('\n')
    expect(output).toContain('result line 11')
    expect(output).not.toContain('result line 12')
    expect(output).toContain('… (3 more lines)')
  })

  it('truncates long code without dropping the tail count', () => {
    const code = Array.from({ length: 15 }, (_, index) => 'line ' + String(index)).join('\n')
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c3',
      name: 'run_code',
      pending: false,
      args: JSON.stringify({ description: 'long script', code }),
    }, options).render(120).join('\n')
    expect(output).toContain('line 11')
    expect(output).not.toContain('line 12')
    expect(output).toContain('… (3 more lines, 15 total)')
    expect(output).toContain('└ done')
  })

  it('falls back to the argument dump for an unknown payload', () => {
    const output = renderTranscriptBlock({
      kind: 'tool',
      callId: 'c4',
      name: 'bash',
      pending: false,
      args: 'not json',
    }, options).render(100).join('\n')
    expect(output).toContain('├ args')
    expect(output).toContain('not json')
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

  it('keeps a notice below the row that was streaming when it was raised', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      liveChunk(2, 1, 1, { type: 'reasoning-delta', text: 'THINKING NOW' }),
    ], [
      { kind: 'notice', tone: 'info', text: 'Session: demo', afterSeq: 1, afterStreamKey: '1:1' },
    ])
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('THINKING NOW')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('Session: demo')).toBeGreaterThan(output.indexOf('THINKING NOW'))
  })

  it('keeps the notice under the row after that row settles', () => {
    const renderer = new TranscriptRenderer(options)
    const entries: TranscriptEntry[] = [
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      liveChunk(2, 1, 1, { type: 'text-delta', text: 'ANSWER' }),
    ]
    const notices: TranscriptBlock[] = [{ kind: 'notice', tone: 'info', text: 'Session: demo', afterSeq: 1, afterStreamKey: '1:1' }]
    renderer.set(entries, notices)
    renderer.set([
      ...entries,
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ANSWER' }] } }, 3),
    ], notices)
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('Session: demo')).toBeGreaterThan(output.indexOf('ANSWER'))
  })

  it('keeps several notices raised during one stream in order', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      liveChunk(2, 1, 1, { type: 'reasoning-delta', text: 'THINKING NOW' }),
    ], [
      { kind: 'notice', tone: 'info', text: 'FIRST NOTICE', afterSeq: 1, afterStreamKey: '1:1' },
      { kind: 'notice', tone: 'warning', text: 'SECOND NOTICE', afterSeq: 1, afterStreamKey: '1:1' },
    ])
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('FIRST NOTICE')).toBeGreaterThan(output.indexOf('THINKING NOW'))
    expect(output.indexOf('SECOND NOTICE')).toBeGreaterThan(output.indexOf('FIRST NOTICE'))
  })

  it('keeps a notice under the failed attempt row it was raised from', () => {
    const stream = [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'FAILED ANSWER' } } },
    ]
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      liveChunk(2, 1, 1, { type: 'text-delta', text: 'FAILED ANSWER' }),
      durable('assistant/attempt', { turn: 1, step: 1, stream }, 3),
    ], [
      { kind: 'notice', tone: 'info', text: 'Session: demo', afterSeq: 1, afterStreamKey: '1:1' },
    ])
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('FAILED ANSWER')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('Session: demo')).toBeGreaterThan(output.indexOf('FAILED ANSWER'))
  })

  it('keeps a notice above a row that starts streaming after it', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([
      durable('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, 1),
      liveChunk(2, 1, 1, { type: 'reasoning-delta', text: 'THINKING NOW' }),
    ], [
      { kind: 'notice', tone: 'info', text: 'Session: demo', afterSeq: 1 },
    ])
    const output = renderer.container.render(80).join('\n')
    expect(output.indexOf('Session: demo')).toBeLessThan(output.indexOf('THINKING NOW'))
  })
})

describe('streamingRowKey', () => {
  const live = (turn: number, step: number): TranscriptEntry => liveChunk(0, turn, step, { type: 'text-delta', text: 'x' })
  const user = (seq: number): TranscriptEntry => durable('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, seq)
  const settled = (seq: number): TranscriptEntry => durable('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: 'done' }] },
  }, seq)

  it('reports the row fed by the tail live chunk', () => {
    expect(streamingRowKey([])).toBeUndefined()
    expect(streamingRowKey([user(1)])).toBeUndefined()
    expect(streamingRowKey([user(1), live(1, 2)])).toBe('1:2')
  })

  it('stops at each event that settles the row', () => {
    expect(streamingRowKey([user(1), live(1, 1), settled(2)])).toBeUndefined()
    expect(streamingRowKey([live(1, 1), settled(2), live(1, 2)])).toBe('1:2')
    expect(streamingRowKey([live(1, 1), durable('assistant/attempt', { turn: 1, step: 1, stream: [] }, 2)])).toBeUndefined()
    expect(streamingRowKey([live(1, 1), durable('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 2)])).toBeUndefined()
  })

  it('ignores trailing durable events that do not settle the row', () => {
    const tool = durable('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 3)
    expect(streamingRowKey([live(1, 1), tool])).toBe('1:1')
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

  it('updates the assistant leaf without replacing either row', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'hello'), assistant(2, 'first')], [])
    const before = [...renderer.container.children]
    renderer.set([user(1, 'hello'), assistant(2, 'second')], [])
    const after = [...renderer.container.children]
    expect(after[0]).toBe(before[0])
    expect(after[after.length - 1]).toBe(before[before.length - 1])
    expect(renderer.container.render(80).join('\n')).toContain('second')
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
    expect(output).toContain('⟳ working · 3s')
    renderer.set([user(1, 'question')], [{ kind: 'waiting', text: waitingText(0, { retry: 1, maxRetries: 3, code: 'TRANSPORT' }, 3_000) }])
    expect(renderer.container.render(80).join('\n')).toContain('retry 1/3 after TRANSPORT')
    // The row is transient, so it leaves no cached component behind.
    expect(renderer.container.children).toHaveLength(3)
  })

  it('reports the trailing live block size for frame pacing', () => {
    const renderer = new TranscriptRenderer(options)
    const text = 'hello there, this is a live answer'
    const entries = [liveChunk(1, 1, 1, { type: 'text-delta', text })]
    renderer.set(entries, [])
    expect(renderer.liveContentLength).toBe(text.length)
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

  it('reports a rebuild that painted the same rows as unchanged', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [user(1, 'hello'), assistant(2, 'world')]
    renderer.set(entries, [])
    expect(renderer.contentChanged).toBe(true)
    renderer.set(entries, [])
    expect(renderer.contentChanged).toBe(false)
  })

  it('reports a rebuild that painted new streamed text as changed', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [liveChunk(1, 1, 1, { type: 'text-delta', text: 'hello' })]
    renderer.set(entries, [])
    for (let frame = 0; frame < 8; frame += 1) renderer.set(entries, [])
    expect(renderer.contentChanged).toBe(false)
    renderer.set([...entries, liveChunk(2, 1, 1, { type: 'text-delta', text: ' world' })], [])
    expect(renderer.contentChanged).toBe(true)
  })

  it('reports a cleared transcript as changed so the screen repaints empty', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'hello')], [])
    renderer.clear()
    renderer.set([], [])
    expect(renderer.contentChanged).toBe(true)
  })
})

describe('TranscriptRenderer paint memo', () => {
  const user = (seq: number, text: string): TranscriptEntry =>
    durable('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)

  /** First row component, which is where the memo lives. */
  const firstRow = (renderer: TranscriptRenderer): { render(width: number): string[] } =>
    renderer.container.children[0] as unknown as { render(width: number): string[] }

  it('paints the same lines array while a row is unchanged at one width', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'hello')], [])
    const row = firstRow(renderer)
    const first = row.render(80)
    expect(row.render(80)).toBe(first)
  })

  it('repaints a row at a new width', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'a long line that wraps differently at each width '.repeat(3))], [])
    const row = firstRow(renderer)
    const wide = row.render(80)
    expect(row.render(40)).not.toBe(wide)
  })

  it('repaints the row whose block changed', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([user(1, 'hello')], [])
    const before = renderer.container.render(80)
    renderer.set([user(1, 'hello again')], [])
    expect(renderer.container.render(80)).not.toBe(before)
    expect(renderer.container.render(80).join(String.fromCharCode(10))).toContain('hello again')
  })

  it('keeps a row memoized across a rebuild that reuses it', () => {
    const renderer = new TranscriptRenderer(options)
    const entries = [user(1, 'hello'), user(2, 'world')]
    renderer.set(entries, [])
    const row = firstRow(renderer)
    const painted = row.render(80)
    renderer.set(entries, [])
    expect(firstRow(renderer)).toBe(row)
    expect(row.render(80)).toBe(painted)
  })

  it('drops the memo of rows whose density changes', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'detailed', runCodeDisplay: 'detailed' })
    renderer.set([durable('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }] },
    }, 1)], [])
    const before = firstRow(renderer)
    const painted = before.render(80)
    renderer.setDisplayModes('compact', 'compact')
    const after = firstRow(renderer)
    expect(after).not.toBe(before)
    // The previous component would otherwise keep rendering its old density.
    expect(after.render(80)).not.toBe(painted)
  })
})
