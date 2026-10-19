import { afterEach, describe, expect, it, vi } from 'vitest'
import { Spacer } from '@earendil-works/pi-tui'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Rule } from '../src/ui/rule.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { contentText, liveChunkHasOutput, nextStreamInterval, reduceTranscript, reduceTranscriptWindow, STREAM_MIN_INTERVAL_MS, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { REASONING_REVEAL_MAX_MS } from '../src/ui/reasoning-reveal.js'
import { sameTranscriptBlock, TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { formatToolArguments } from '../src/ui/tool-preview.js'
import { WAIT_ROW_DELAY_MS, waitingText, waitingVisible } from '../src/ui/waiting.js'

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

function toolResult(callId: string, text: string, seq: number): TranscriptEntry {
  return durable('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
    },
  }, seq)
}

function ptcStart(subCallId: string, name: string, args: unknown, seq: number, parentCallId = 'call-outer'): TranscriptEntry {
  return durable('tool/ptc-dispatch-start', {
    rootCallId: parentCallId,
    parentCallId,
    subCallId,
    name,
    arguments: args,
  }, seq)
}

function ptcSettle(
  subCallId: string,
  name: string,
  text: string,
  meta: unknown,
  seq: number,
  parentCallId = 'call-outer',
  args: unknown = {},
): TranscriptEntry {
  return durable('tool/ptc-dispatch', {
    rootCallId: parentCallId,
    parentCallId,
    subCallId,
    name,
    arguments: args,
    isError: false,
    content: [{ type: 'text', text }],
    ...(meta === undefined ? {} : { meta }),
  }, seq)
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

  it('reveals a completed reasoning block that arrived without deltas', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    const partialBlock = partial.blocks[0]
    expect(partialBlock?.kind).toBe('assistant')
    if (partialBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(partialBlock.reasoning).toHaveLength(200)
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_200)
    const fullBlock = full.blocks[0]
    expect(fullBlock?.kind).toBe('assistant')
    if (fullBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(fullBlock.reasoning).toBe(reasoning)
    expect(full.revealPending).toBe(false)
  })

  it('keeps streamed reasoning complete when the terminal block arrives', () => {
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'reasoning-delta', index: 0, text: 'reasoned ' }, 1_000),
      liveChunk(2, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reasoned fully' } }, 1_001),
    ]
    const reduction = reduceTranscriptWindow(entries, options, 1_001)
    const block = reduction.blocks[0]
    expect(block?.kind).toBe('assistant')
    if (block?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(block.reasoning).toBe('reasoned fully')
    expect(reduction.revealPending).toBe(false)
  })

  it('adopts a completed text block when no text delta arrived', () => {
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'text', text: 'complete answer' } }, 1_000),
    ]
    const blocks = reduceTranscript(entries, options, 1_001)
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'complete answer', live: true })
  })

  it('continues revealing a durable reasoning block that has no deltas', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'answer' }] },
        stream: [
          { type: 'chunk', time: 1_000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } },
          { type: 'chunk', time: 1_100, chunk: { type: 'usage', usage: { outputTokens: 10 } } },
        ],
      }, 2),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    const partialBlock = partial.blocks.at(-1)
    expect(partialBlock?.kind).toBe('assistant')
    if (partialBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(partialBlock.reasoning).toHaveLength(200)
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_200)
    const fullBlock = full.blocks.at(-1)
    expect(fullBlock?.kind).toBe('assistant')
    if (fullBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(fullBlock.reasoning).toBe(reasoning)
    expect(full.revealPending).toBe(false)
  })

  it('does not re-reveal a durable block that streamed reasoning deltas', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'reasoning', text: reasoning }] },
        stream: [
          { type: 'reasoning-chunks', time0: 1_000, index: 0, dt: [], texts: [reasoning] },
          { type: 'chunk', time: 1_001, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } },
        ],
      }, 2),
    ]
    const reduction = reduceTranscriptWindow(entries, options, 1_001)
    const block = reduction.blocks.at(-1)
    expect(block?.kind).toBe('assistant')
    if (block?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(block.reasoning).toBe(reasoning)
    expect(reduction.revealPending).toBe(false)
  })

  it('shows a thinking placeholder at reasoning block-start', () => {
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-start', index: 0, blockType: 'reasoning' }, 1_000),
    ]
    const reduction = reduceTranscriptWindow(entries, options, 1_000)
    expect(reduction.blocks[0]).toMatchObject({ kind: 'assistant', live: true, starting: true })
    expect(reduction.revealPending).toBe(false)

    const renderer = new TranscriptRenderer(options)
    renderer.set(entries, [])
    expect(renderer.container.render(80).join('\n')).toContain('thinking …')
  })

  it('starts a tracked reveal at the first render instead of block-end time', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const revealProgress = new Map()
    const tracked = { ...options, revealProgress }

    const first = reduceTranscriptWindow(entries, tracked, 1_200)
    const firstBlock = first.blocks[0]
    expect(firstBlock?.kind).toBe('assistant')
    if (firstBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(firstBlock.reasoning).toHaveLength(1)
    expect(first.revealPending).toBe(true)

    const next = reduceTranscriptWindow(entries, tracked, 1_233)
    const nextBlock = next.blocks[0]
    expect(nextBlock?.kind).toBe('assistant')
    if (nextBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(nextBlock.reasoning).toHaveLength(132)
  })

  it('catches up instead of stretching a reveal when a frame is late', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const revealProgress = new Map()
    const tracked = { ...options, revealProgress }

    reduceTranscriptWindow(entries, tracked, 1_000)
    // The next frame arrives 100ms later: the reveal advances 100ms worth of
    // text rather than one capped step, so a dropped frame costs no animation time.
    const late = reduceTranscriptWindow(entries, tracked, 1_100)
    const lateBlock = late.blocks[0]
    expect(lateBlock?.kind).toBe('assistant')
    if (lateBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect((lateBlock.reasoning ?? '').length).toBeGreaterThan(160)
    expect(revealProgress.size).toBe(1)
  })

  it('finishes every reveal inside the wall-clock budget even on slow frames', () => {
    const reasoning = 'x'.repeat(3_000)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const revealProgress = new Map()
    const tracked = { ...options, revealProgress }
    // A terminal repainting at 10fps must not turn the 600ms budget into 1.9s.
    let now = 1_000
    let pending = true
    while (pending && now - 1_000 <= REASONING_REVEAL_MAX_MS + 100) {
      pending = reduceTranscriptWindow(entries, tracked, now).revealPending
      now += 100
    }
    expect(pending).toBe(false)
    expect(now - 1_000).toBeLessThanOrEqual(REASONING_REVEAL_MAX_MS + 100)
  })

  it('drops a settled step reveal clock so a retry starts from one grapheme', () => {
    const first = 'a'.repeat(400)
    const retry = 'b'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: first } }, 1_000),
    ]
    const revealProgress = new Map()
    const tracked = { ...options, revealProgress }
    for (let now = 1_000; now <= 1_700; now += 33) reduceTranscriptWindow(entries, tracked, now)
    expect(revealProgress.size).toBe(1)

    const settled: TranscriptEntry[] = [
      ...entries,
      durable('assistant/attempt', { turn: 1, step: 1, stream: [] }, 2),
      liveChunk(3, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: retry } }, 1_700),
    ]
    const retried = reduceTranscriptWindow(settled, tracked, 1_700)
    const retriedBlock = retried.blocks.at(-1)
    expect(retriedBlock?.kind).toBe('assistant')
    if (retriedBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    // The retried attempt reveals from the start instead of inheriting the
    // first attempt's completed count.
    expect(retriedBlock.reasoning).toHaveLength(1)
    expect(retried.revealPending).toBe(true)
  })

  it('does not reveal or hold in the compact thinking display', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
    ]
    const compact = { ...options, thinkingDisplay: 'compact' as const }
    // Compact renders one line, so there is no reveal to finish. The tool card
    // still waits out the settle grace so it does not share a frame with the
    // freshly settled assistant row.
    const settled = reduceTranscriptWindow(entries, compact, 1_010)
    expect(settled.blocks.map(block => block.kind)).toEqual(['assistant'])
    expect(settled.revealPending).toBe(true)

    const reduction = reduceTranscriptWindow(entries, compact, 1_200)
    expect(reduction.revealPending).toBe(false)
    expect(reduction.blocks.map(block => block.kind)).toEqual(['assistant', 'tool'])
    const block = reduction.blocks[0]
    expect(block?.kind).toBe('assistant')
    if (block?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(block.reasoning).toBe(reasoning)
  })

  it('reveals whole grapheme clusters', () => {
    const reasoning = '🧠'.repeat(100)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_010)
    const block = partial.blocks[0]
    expect(block?.kind).toBe('assistant')
    if (block?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(block.reasoning).toBe('🧠'.repeat(40))
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_200)
    const fullBlock = full.blocks[0]
    expect(fullBlock?.kind).toBe('assistant')
    if (fullBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(fullBlock.reasoning).toBe(reasoning)
    expect(full.revealPending).toBe(false)
  })

  it('stops holding once the displayed reasoning limit is revealed', () => {
    const reasoning = 'x'.repeat(6_000)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_599)
    const partialBlock = partial.blocks[0]
    expect(partialBlock?.kind).toBe('assistant')
    if (partialBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(partialBlock.reasoning).toHaveLength(2_995)
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_600)
    const fullBlock = full.blocks[0]
    expect(fullBlock?.kind).toBe('assistant')
    if (fullBlock?.kind !== 'assistant') throw new Error('expected an assistant block')
    expect(fullBlock.reasoning).toBe(reasoning)
    expect(full.revealPending).toBe(false)
  })

  it('holds the next row until a revealing reasoning block completes', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    expect(partial.revealPending).toBe(true)
    expect(partial.blocks).toHaveLength(1)
    expect(partial.blocks[0]).toMatchObject({ kind: 'assistant', live: true, revealing: true })

    const full = reduceTranscriptWindow(entries, options, 1_200)
    expect(full.revealPending).toBe(false)
    expect(full.blocks.map(block => block.kind)).toEqual(['assistant', 'tool'])
    expect(full.blocks[1]).toMatchObject({ kind: 'tool', name: 'run_code' })
  })

  it('shows a new user message instead of holding it behind the reveal', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('user/message', { content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }, 2),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 3),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    expect(partial.blocks.map(block => block.kind)).toEqual(['assistant', 'user', 'tool'])
    expect(partial.revealPending).toBe(true)
  })

  it('keeps a tool row off the frame that settles streamed reasoning', () => {
    // The delta path has no local reveal, so without a settle grace the last
    // thinking delta and the tool call that follows it within a few ms land on
    // one paint: the card looks like it appeared the instant thinking ended.
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'reasoning-delta', index: 0, text: 'thought' }, 1_000),
      liveChunk(2, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } }, 1_002),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 3),
    ]
    const settled = reduceTranscriptWindow(entries, options, 1_005)
    expect(settled.blocks.map(block => block.kind)).toEqual(['assistant'])
    expect(settled.revealPending).toBe(true)

    const nextPaint = reduceTranscriptWindow(entries, options, 1_250)
    expect(nextPaint.blocks.map(block => block.kind)).toEqual(['assistant', 'tool'])
    expect(nextPaint.revealPending).toBe(false)
  })

  it('holds a tool row behind the reveal but still shows a following failure', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
      durable('turn/end', { reason: { kind: 'max-tokens' } }, 3),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    // The tool card preceded the failure, so it stays hidden until the reveal
    // ends; the warning itself is shown rather than hidden behind the animation.
    expect(partial.blocks.map(block => block.kind)).toEqual(['assistant', 'notice'])
    expect(partial.blocks[1]).toMatchObject({ tone: 'warning' })
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_200)
    expect(full.blocks.map(block => block.kind)).toEqual(['assistant', 'tool', 'notice'])
  })

  it('keeps informational notices behind the reveal', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
      durable('compaction/prune', { shadowedSeqs: [1], shadowedTokenCount: 10 }, 3),
    ]
    const partial = reduceTranscriptWindow(entries, options, 1_050)
    expect(partial.blocks.map(block => block.kind)).toEqual(['assistant'])
    expect(partial.revealPending).toBe(true)

    const full = reduceTranscriptWindow(entries, options, 1_200)
    expect(full.blocks.map(block => block.kind)).toEqual(['assistant', 'tool', 'notice'])
  })

  it('stops revealing once the durable assistant message settles the step', () => {
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      durable('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'answer' }] },
      }, 2),
    ]
    const reduction = reduceTranscriptWindow(entries, options, 1_050)
    expect(reduction.revealPending).toBe(false)
    expect(reduction.blocks.at(-1)).toMatchObject({ kind: 'assistant', live: false, text: 'answer', reasoning })
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

  it('ignores a duplicate tool result for a settled call', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 1),
      toolResult('call-1', 'first output', 2),
      toolResult('call-1', 'duplicate output', 3),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'call-1',
      result: 'first output',
      pending: false,
      seq: 2,
    })
  })

  it('ignores a duplicate tool call for an already rendered call', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{"first":true}' }, 1),
      toolResult('call-1', 'first output', 2),
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{"second":true}' }, 3),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'tool', callId: 'call-1', result: 'first output', pending: false })
  })

  it('renders the original tool events again on a rebuild with persistent memory', () => {
    const toolMemory = {
      settled: new Set<string>(),
      pruned: new Set<string>(),
      prunedSeqs: new Set<number>(),
      callBySeq: new Map<number, string>(),
    }
    const tracked = { ...options, toolMemory }
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 1),
      toolResult('call-1', 'first output', 2),
    ]
    const first = reduceTranscriptWindow(entries, tracked, 1_000)
    const second = reduceTranscriptWindow(entries, tracked, 1_000)
    expect(first.blocks).toHaveLength(1)
    expect(second.blocks).toHaveLength(1)
    expect(second.blocks[0]).toMatchObject({ kind: 'tool', callId: 'call-1', result: 'first output' })
  })

  it('ignores a duplicate pending tool call across a sliced window', () => {
    const toolMemory = {
      settled: new Set<string>(),
      pruned: new Set<string>(),
      prunedSeqs: new Set<number>(),
      callBySeq: new Map<number, string>(),
    }
    const tracked = { ...options, toolMemory }
    const first = reduceTranscriptWindow([
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 1),
    ], tracked, 1_000)
    expect(first.blocks).toHaveLength(1)

    const late = reduceTranscriptWindow([
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
    ], tracked, 1_000)
    expect(late.blocks).toHaveLength(0)
  })

  it('renders a nested edit card with diff rows from PTC', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-outer', name: 'run_code', arguments: '{}' }, 1),
      ptcStart('call-outer:ptc:1', 'edit', { file_path: 'a.ts' }, 2),
      ptcSettle('call-outer:ptc:1', 'edit', 'updated a.ts', {
        diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
      }, 3),
      toolResult('call-outer', 'nested output', 4),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'tool', callId: 'call-outer', pending: false })
    expect(blocks[1]).toMatchObject({
      kind: 'tool',
      callId: 'call-outer:ptc:1',
      name: 'edit',
      result: 'updated a.ts',
      pending: false,
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    })
    const output = renderTranscriptBlock(blocks[1]!, options).render(100).join('\n')
    expect(output).toContain('├ diff')
    expect(output).toContain('│ - old')
    expect(output).toContain('│ + new')
  })

  it('settles a PTC edit card whose start left the window', () => {
    const entries: TranscriptEntry[] = [
      ptcSettle('call-outer:ptc:1', 'edit', 'updated a.ts', {
        diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
      }, 2),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'tool', name: 'edit', pending: false, seq: 2 })
  })

  it('keeps non-editing PTC sub-calls inside the parent card', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-outer', name: 'run_code', arguments: '{}' }, 1),
      ptcStart('call-outer:ptc:1', 'bash', { command: 'ls' }, 2),
      ptcSettle('call-outer:ptc:1', 'bash', 'file.txt', undefined, 3),
      ptcStart('call-outer:ptc:2', 'write', { file_path: 'b.ts', content: 'x' }, 4),
      ptcSettle('call-outer:ptc:2', 'write', 'created b.ts', {
        operation: 'create',
        path: 'b.ts',
        diffs: [],
      }, 5, 'call-outer', { file_path: 'b.ts', content: 'x' }),
      toolResult('call-outer', 'done', 6),
    ]
    const blocks = reduceTranscript(entries, options)
    const tools = blocks.filter(block => block.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[1]).toMatchObject({
      name: 'write',
      callId: 'call-outer:ptc:2',
      pending: false,
      diffs: [{ path: 'b.ts', oldText: null, newText: 'x' }],
    })
  })

  it('rebuilds a created file diff from the native write call arguments', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-write',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'c.ts', content: 'hello' }),
      }, 1),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-write' },
          toolCallId: 'call-write',
          content: [{ type: 'text', text: 'Created file' }],
          isError: false,
        },
        meta: { operation: 'create', path: 'c.ts', diffs: [] },
      }, 2),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      name: 'write',
      diffs: [{ path: 'c.ts', oldText: null, newText: 'hello' }],
    })
    const output = renderTranscriptBlock(blocks[0]!, options).render(100).join('\n')
    expect(output).toContain('│ + hello')
  })

  it('deduplicates PTC events and rebuilds the same nested card', () => {
    const toolMemory = {
      settled: new Set<string>(),
      pruned: new Set<string>(),
      prunedSeqs: new Set<number>(),
      callBySeq: new Map<number, string>(),
    }
    const tracked = { ...options, toolMemory }
    const entries: TranscriptEntry[] = [
      ptcStart('call-outer:ptc:1', 'edit', { file_path: 'a.ts' }, 2),
      ptcSettle('call-outer:ptc:1', 'edit', 'updated a.ts', {
        diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
      }, 3),
      ptcStart('call-outer:ptc:1', 'edit', { file_path: 'a.ts' }, 4),
      ptcSettle('call-outer:ptc:1', 'edit', 'duplicate', undefined, 5),
    ]
    const first = reduceTranscriptWindow(entries, tracked, 1_000)
    expect(first.blocks).toHaveLength(1)
    expect(first.blocks[0]).toMatchObject({ pending: false, result: 'updated a.ts', seq: 3 })

    const second = reduceTranscriptWindow(entries, tracked, 1_000)
    expect(second.blocks).toHaveLength(1)
    expect(second.blocks[0]).toMatchObject({ pending: false, result: 'updated a.ts', seq: 3 })
  })

  it('hides nested edit cards when the parent run_code output is pruned', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-outer', name: 'run_code', arguments: '{}' }, 1),
      ptcStart('call-outer:ptc:1', 'edit', { file_path: 'a.ts' }, 2),
      ptcSettle('call-outer:ptc:1', 'edit', 'updated a.ts', {
        diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
      }, 3),
      toolResult('call-outer', 'nested output', 4),
      durable('compaction/prune', { shadowedSeqs: [4], shadowedTokenCount: 10 }, 5),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks.some(block => block.kind === 'tool')).toBe(false)
    expect(blocks.some(block => block.kind === 'notice' && block.text.includes('pruned'))).toBe(true)
  })

  it('keeps prune memory after the original entries leave the window', () => {
    const toolMemory = {
      settled: new Set<string>(),
      pruned: new Set<string>(),
      prunedSeqs: new Set<number>(),
      callBySeq: new Map<number, string>(),
    }
    const tracked = { ...options, toolMemory }
    reduceTranscriptWindow([
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 1),
      toolResult('call-1', 'original output', 2),
      durable('compaction/prune', { shadowedSeqs: [2], shadowedTokenCount: 900 }, 3),
    ], tracked, 1_000)
    expect(toolMemory.pruned.has('call-1')).toBe(true)

    const late = reduceTranscriptWindow([toolResult('call-1', 'late output', 4)], tracked, 1_000)
    expect(late.blocks).toHaveLength(0)
  })

  it('prunes tool output and ignores a late duplicate result', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 1),
      toolResult('call-1', 'original output', 2),
      durable('compaction/prune', { shadowedSeqs: [2], shadowedTokenCount: 900 }, 3),
      toolResult('call-1', 'late duplicate', 4),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'notice', text: 'Tool output pruned · 1 item(s) · ~900 tokens' })

    const renderer = new TranscriptRenderer(options)
    renderer.set(entries, [])
    const output = renderer.container.render(80).join('\n')
    expect(output).not.toContain('original output')
    expect(output).not.toContain('late duplicate')
  })

  it('renders one compaction summary instead of a duplicate checkpoint context', () => {
    const summary = 'condensed checkpoint'
    const checkpoint = { content: [{ type: 'text', text: 'checkpoint prefix\n' + 'long detail '.repeat(200) }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } }
    const withCard: TranscriptEntry[] = [
      durable('compaction/start', { compactionId: 'c1', turn: 1 }, 1),
      durable('compaction/summary', {
        compactionId: 'c1',
        summary: [{ type: 'text', text: summary }],
        shadowedSeqs: [1],
        shadowedTokenCount: 100,
      }, 2),
      durable('user/message', checkpoint, 3),
      durable('compaction/end', { compactionId: 'c1', turn: 1 }, 4),
    ]
    const blocks = reduceTranscript(withCard, options)
    expect(blocks.filter(block => block.kind === 'context')).toHaveLength(0)
    expect(blocks[0]).toMatchObject({ kind: 'compaction', summary })

    const detached = reduceTranscript([durable('user/message', checkpoint, 5)], options)
    expect(detached[0]).toMatchObject({ kind: 'context', label: 'compact-checkpoint' })
    expect(detached[0]?.kind === 'context' ? detached[0].text.length : 0).toBeLessThanOrEqual(300)
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

  it('marks a compaction start left open by a crashed process as interrupted', () => {
    // A crash between compaction/start and compaction/end leaves the durable
    // lock held. Resuming appends turn/end{interrupted} and then
    // session/end-seed (that is the order the Host writes), so the card must
    // read as interrupted rather than as a summarizer failure or still running.
    const abandoned: TranscriptEntry[] = [
      durable('compaction/start', { compactionId: 'c1', turn: 1 }, 1),
      durable('compaction/prune', { shadowedSeqs: [2], shadowedTokenCount: 10 }, 2),
    ]
    const live = reduceTranscript(abandoned, options)
    expect(live[0]).toMatchObject({ kind: 'compaction', state: 'running' })

    const closedByTurn: TranscriptEntry[] = [
      ...abandoned,
      durable('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 3),
      durable('session/end-seed', {}, 4),
    ]
    const reopened = reduceTranscript(closedByTurn, options)
    expect(reopened[0]).toMatchObject({ kind: 'compaction', state: 'interrupted' })
    expect(reopened[0]?.kind === 'compaction' ? reopened[0].error : undefined).toBeUndefined()

    const renderer = new TranscriptRenderer(options)
    renderer.set(closedByTurn, [])
    const output = renderer.container.render(80).join('\n')
    expect(output).toContain('Compaction interrupted')
    expect(output).not.toContain('Compacting context…')
    expect(output).not.toContain('Compaction failed')

    // The resume marker alone closes it too: a log whose turn already ended
    // before the crash still holds the compaction lock until the seed marker.
    const seedOnly = reduceTranscript([...abandoned, durable('session/end-seed', {}, 5)], options)
    expect(seedOnly[0]).toMatchObject({ kind: 'compaction', state: 'interrupted' })
  })

  it('keeps a compaction that later events closed in the error state', () => {
    // Without the resume marker the log simply continued past the start: that
    // is a summarizer failure, not a process that died mid-compaction.
    const entries: TranscriptEntry[] = [
      durable('compaction/start', { compactionId: 'c1', turn: 1 }, 1),
      durable('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'next' }] }, stream: [] }, 2),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks[0]).toMatchObject({ kind: 'compaction', state: 'error', error: 'Compaction did not finish' })
  })

  it('reports a turn the Host closed during resume', () => {
    const entries: TranscriptEntry[] = [
      durable('turn/start', { turn: 1 }, 1),
      durable('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 2),
    ]
    const blocks = reduceTranscript(entries, options)
    expect(blocks.at(-1)).toMatchObject({ kind: 'notice', tone: 'warning', text: 'Turn interrupted before it finished' })
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

  it('streams the answer while its reasoning is still revealing', () => {
    const renderer = new TranscriptRenderer({ ...options, thinkingDisplay: 'detailed' })
    const reasoning = 'x'.repeat(400)
    const entries: TranscriptEntry[] = [
      liveChunk(1, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }, 1_000),
      liveChunk(2, 1, 1, { type: 'text-delta', index: 1, text: 'final answer' }, 1_001),
    ]
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    renderer.set(entries, [])
    const partial = renderer.container.render(80).join('\n')
    expect(partial).toContain('thinking')
    // The answer is real streamed content, so it appears on its own schedule;
    // only the tool rows behind the reveal wait for it.
    expect(partial).toContain('final answer')

    vi.setSystemTime(1_200)
    renderer.set(entries, [])
    const full = renderer.container.render(80).join('\n')
    expect(full).toContain('final answer')
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

afterEach(() => {
  vi.useRealTimers()
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

describe('liveChunkHasOutput', () => {
  it('keeps the wait row for marker-only chunks', () => {
    expect(liveChunkHasOutput({ type: 'block-start', index: 0, blockType: 'reasoning' })).toBe(false)
    expect(liveChunkHasOutput({ type: 'text-delta', index: 0, text: '   ' })).toBe(false)
    expect(liveChunkHasOutput({ type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), argumentsDelta: '' })).toBe(false)
    expect(liveChunkHasOutput({ type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'run', argumentsDelta: '{}' })).toBe(false)
    expect(liveChunkHasOutput({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId('c1'), name: 'run', arguments: '{}' },
    })).toBe(false)
  })

  it('clears the wait row once visible output exists', () => {
    expect(liveChunkHasOutput({ type: 'reasoning-delta', index: 0, text: 'thinking' })).toBe(true)
    expect(liveChunkHasOutput({ type: 'text-delta', index: 0, text: 'answer' })).toBe(true)
    expect(liveChunkHasOutput({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } })).toBe(true)
  })

  it('ignores reasoning while the thinking display is hidden', () => {
    expect(liveChunkHasOutput({ type: 'reasoning-delta', index: 0, text: 'thinking' }, false)).toBe(false)
    expect(liveChunkHasOutput({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } }, false)).toBe(false)
    expect(liveChunkHasOutput({ type: 'text-delta', index: 0, text: 'answer' }, false)).toBe(true)
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

