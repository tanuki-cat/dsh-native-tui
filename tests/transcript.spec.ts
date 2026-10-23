import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { contentText, reduceTranscript, reduceTranscriptWindow, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'
import { frameCostMs, frameOverrunMs, nextFrameDelay, nextStreamInterval, STREAM_MIN_INTERVAL_MS, STREAM_PAINT_CEILING_MS, transcriptFrameChanged } from '../src/ui/stream-pacing.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { formatToolArguments } from '../src/ui/tool-preview.js'

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
    const first = reduceTranscriptWindow(entries, tracked)
    const second = reduceTranscriptWindow(entries, tracked)
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
    ], tracked)
    expect(first.blocks).toHaveLength(1)

    const late = reduceTranscriptWindow([
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{}' }, 2),
    ], tracked)
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
    expect(output).toContain('⚙ edit · a.ts')
    expect(output).not.toContain('├ args')
    expect(output).not.toContain('updated a.ts')
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

  it('lists the tools a compact run_code dispatched', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-outer',
        name: 'run_code',
        arguments: JSON.stringify({ description: 'Explore', code: 'const files = 1' }),
      }, 1),
      ptcStart('call-outer:ptc:1', 'read', { file_path: 'src/a.ts' }, 2),
      ptcStart('call-outer:ptc:2', 'read', { file_path: 'src/a.ts' }, 3),
      ptcStart('call-outer:ptc:3', 'bash', { command: 'ls -la' }, 4),
      ptcStart('call-outer:ptc:4', 'mcp__idea__get_file_problems', { file_path: 'src/a.ts' }, 5),
      ptcStart('call-outer:ptc:5', 'edit', { file_path: 'src/b.ts' }, 6),
      toolResult('call-outer', 'done', 7),
    ]
    const compactOptions = { ...options, runCodeDisplay: 'compact' as const }
    const compact = reduceTranscript(entries, compactOptions)
    const parent = compact.find(block => block.kind === 'tool' && block.callId === 'call-outer')
    // Repeated reads collapse, and an editing sub-call keeps its own card
    // instead of repeating in the list.
    expect(parent).toMatchObject({
      kind: 'tool',
      name: 'run_code',
      callLines: ['read src/a.ts', 'bash ls -la', 'mcp idea'],
    })
    const output = renderTranscriptBlock(parent!, compactOptions).render(100).join('\n')
    expect(output).toContain('⚙ run_code')
    expect(output).toContain('├ read src/a.ts')
    expect(output).toContain('├ bash ls -la')
    expect(output).toContain('├ mcp idea')
    expect(output).toContain('└ done')
    expect(output).not.toContain('const files = 1')
    expect(output).not.toContain('├ edit')

    const detailedParent = reduceTranscript(entries, options)
      .find(block => block.kind === 'tool' && block.callId === 'call-outer')
    expect(detailedParent).not.toHaveProperty('callLines')
    const detailedOutput = renderTranscriptBlock(detailedParent!, options).render(100).join('\n')
    expect(detailedOutput).toContain('⚙ run_code · Explore')
    expect(detailedOutput).toContain('const files = 1')
  })

  it('bounds the compact call list of a busy run_code', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-outer', name: 'run_code', arguments: '{}' }, 1),
      ...Array.from({ length: 12 }, (_, index) => ptcStart(
        'call-outer:ptc:' + String(index),
        'read',
        { file_path: 'src/' + String(index) + '.ts' },
        index + 2,
      )),
      toolResult('call-outer', 'done', 20),
    ]
    const compactOptions = { ...options, runCodeDisplay: 'compact' as const }
    const parent = reduceTranscript(entries, compactOptions)
      .find(block => block.kind === 'tool' && block.callId === 'call-outer')
    expect(parent).toMatchObject({ callLinesOmitted: 2 })
    expect(parent !== undefined && parent.kind === 'tool' ? parent.callLines : undefined).toHaveLength(10)
    const output = renderTranscriptBlock(parent!, compactOptions).render(100).join('\n')
    expect(output).toContain('├ … 2 more')
  })

  it('keeps the failure message on a compact run_code that lists calls', () => {
    const entries: TranscriptEntry[] = [
      durable('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-outer',
        name: 'run_code',
        arguments: JSON.stringify({ description: 'Explore', code: 'await tools.read({})' }),
      }, 1),
      ptcStart('call-outer:ptc:1', 'read', { file_path: 'missing.ts' }, 2),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { callId: 'call-outer' },
          content: [{ type: 'text', text: 'Error: ENOENT: no such file or directory, open missing.ts' }],
          isError: true,
        },
      }, 3),
    ]
    const compactOptions = { ...options, runCodeDisplay: 'compact' as const }
    const parent = reduceTranscript(entries, compactOptions)
      .find(block => block.kind === 'tool' && block.callId === 'call-outer')
    const output = renderTranscriptBlock(parent!, compactOptions).render(100).join('\n')
    expect(output).toContain('├ read missing.ts')
    expect(output).toContain('├ ✕ Error: ENOENT: no such file or directory, open missing.ts')
    expect(output).toContain('└ error')
    expect(output).not.toContain('await tools.read')
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
    expect(output).toContain('write c.ts')
    expect(output).toContain('hello')
    expect(output).not.toContain('│ + hello')
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
    const first = reduceTranscriptWindow(entries, tracked)
    expect(first.blocks).toHaveLength(1)
    expect(first.blocks[0]).toMatchObject({ pending: false, result: 'updated a.ts', seq: 3 })

    const second = reduceTranscriptWindow(entries, tracked)
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
    ], tracked)
    expect(toolMemory.pruned.has('call-1')).toBe(true)

    const late = reduceTranscriptWindow([toolResult('call-1', 'late output', 4)], tracked)
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
    expect(output).toContain('◆ compaction')
    expect(output).toContain('✓ done')
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
    expect(output).toContain('⚠ interrupted')
    expect(output).not.toContain('⟳ compacting…')
    expect(output).not.toContain('✕ failed')

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

  it('keeps a saturated window stable between batched trims', () => {
    // Main-screen repaints the whole transcript when the window top changes,
    // so a large window only trims once a whole batch has overflowed. Between
    // trims the overflow rows stay visible and the notice text never rewrites
    // its number.
    const capped = { ...options, maxEntries: 100 }
    const entries: TranscriptEntry[] = []
    for (let seq = 1; seq <= 130; seq += 1) {
      entries.push(durable('user/message', { content: [{ type: 'text', text: 'm' + String(seq) }], source: { kind: 'user' } }, seq))
    }
    const first = reduceTranscriptWindow(entries, capped)
    expect(first.blocks).toHaveLength(130)
    expect(first.blocks[0]).toMatchObject({ kind: 'user', text: 'm1' })

    // Overflow below the batch: nothing is dropped, so the newest row is kept.
    entries.push(durable('user/message', { content: [{ type: 'text', text: 'm131' }], source: { kind: 'user' } }, 131))
    const beforeBatch = reduceTranscriptWindow(entries, capped)
    expect(beforeBatch.blocks.at(-1)).toMatchObject({ kind: 'user', text: 'm131' })
    expect(beforeBatch.blocks[0]).toMatchObject({ kind: 'user', text: 'm1' })

    // The batch overflows: the trim lands in one step and the notice stays.
    for (let seq = 132; seq <= 160; seq += 1) {
      entries.push(durable('user/message', { content: [{ type: 'text', text: 'm' + String(seq) }], source: { kind: 'user' } }, seq))
    }
    const afterBatch = reduceTranscriptWindow(entries, capped)
    expect(afterBatch.blocks[0]).toMatchObject({ kind: 'notice', tone: 'info' })
    expect(afterBatch.blocks[0]?.kind === 'notice' ? afterBatch.blocks[0].text : '').not.toMatch(/\d/)
    expect(afterBatch.blocks).toHaveLength(101)
    expect(afterBatch.retainedFrom).toBeGreaterThan(first.retainedFrom)
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

describe('frameOverrunMs', () => {
  it('measures lateness against the due time', () => {
    expect(frameOverrunMs(1_000, 1_012)).toBe(12)
    expect(frameOverrunMs(1_000, 990)).toBe(0)
  })

  it('reports zero for an inline frame or an unusable clock', () => {
    expect(frameOverrunMs(undefined, 1_000)).toBe(0)
    expect(frameOverrunMs(Number.NaN, 1_000)).toBe(0)
    expect(frameOverrunMs(1_000, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('frameCostMs', () => {
  it('adds the rebuild to the measured slip', () => {
    expect(frameCostMs(4, 20, 33)).toBe(24)
  })

  it('caps the slip at the interval the frame ran on', () => {
    // A 300 ms stall unrelated to the paint doubles the interval once instead
    // of commanding a 600 ms backoff.
    expect(frameCostMs(0, 300, 33)).toBe(33)
  })

  it('still backs off a genuinely expensive paint to twice its cost', () => {
    // The cap moves with the interval, so each late frame doubles it until the
    // paint fits in half of the loop.
    let interval = STREAM_MIN_INTERVAL_MS
    for (const expected of [66, 132, 264, 500]) {
      interval = nextStreamInterval(interval, frameCostMs(0, 250, interval))
      expect(interval).toBe(expected)
    }
  })

  it('ignores non-finite measurements', () => {
    expect(frameCostMs(Number.NaN, Number.NaN, 33)).toBe(0)
  })
})

describe('nextStreamInterval', () => {
  it('holds the streaming floor for a cheap frame', () => {
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 0)).toBe(STREAM_MIN_INTERVAL_MS)
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 2)).toBe(STREAM_MIN_INTERVAL_MS)
  })

  it('narrows back toward the floor after a cheap frame', () => {
    expect(nextStreamInterval(100, 1)).toBe(75)
  })

  it('holds the interval to twice the measured frame cost', () => {
    // A frame may occupy half the loop; the reader that turns model bytes into
    // events — and stamps the timestamps the decode rate is measured from —
    // gets the other half. A frame that just cost 90 ms is followed by a 180 ms
    // interval immediately, not one frame later.
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 90)).toBe(180)
    expect(nextStreamInterval(400, 300)).toBe(STREAM_PAINT_CEILING_MS)
  })

  it('recovers toward the floor one step at a time', () => {
    // One cheap frame inside a heavy window must not snap the interval back and
    // paint the loop back to back; it earns a quarter of the distance.
    expect(nextStreamInterval(400, 10)).toBe(300)
    expect(nextStreamInterval(120, 40)).toBe(90)
  })

  it('converges on the measured frame cost instead of running to the ceiling', () => {
    // 20 ms frames want a 40 ms interval. Starting from the floor it must settle
    // near there rather than climb: over-pacing discards streaming frames for no
    // gain once the loop already has enough room.
    let interval = STREAM_MIN_INTERVAL_MS
    for (let frame = 0; frame < 40; frame += 1) interval = nextStreamInterval(interval, 20)
    expect(interval).toBe(40)
  })

  it('keeps widening on a sustained budget overrun until the ceiling', () => {
    let interval = STREAM_MIN_INTERVAL_MS
    for (let frame = 0; frame < 40; frame += 1) interval = nextStreamInterval(interval, 600)
    expect(interval).toBe(STREAM_PAINT_CEILING_MS)
  })

  it('caps the paint-bound interval so a pathological frame cannot stall the stream', () => {
    expect(nextStreamInterval(STREAM_MIN_INTERVAL_MS, 10_000)).toBe(STREAM_PAINT_CEILING_MS)
  })
})

describe('nextFrameDelay', () => {
  it('waits a full interval when the last paint just happened', () => {
    expect(nextFrameDelay(33, 0)).toBe(33)
  })

  it('keeps frames on a cadence measured from the last paint', () => {
    // 20 ms after a paint, only the remaining 13 ms of the interval is due:
    // waiting a full interval here would alternate 33/53 ms frames.
    expect(nextFrameDelay(33, 20)).toBe(13)
    expect(nextFrameDelay(33, 33)).toBe(0)
  })

  it('does not go negative when a paint is overdue', () => {
    expect(nextFrameDelay(33, 120)).toBe(0)
    expect(nextFrameDelay(33, -5)).toBe(33)
  })
})

describe('transcriptFrameChanged', () => {
  const painted = { revision: 7, wait: '' }

  it('paints a new revision or a changed wait row', () => {
    expect(transcriptFrameChanged(painted, { revision: 8, wait: '' })).toBe(true)
    expect(transcriptFrameChanged(painted, { revision: 7, wait: 'waiting · 2s' })).toBe(true)
  })

  it('skips a frame with nothing new', () => {
    expect(transcriptFrameChanged(painted, { revision: 7, wait: '' })).toBe(false)
  })

  it('paints when the transcript revision changes', () => {
    expect(transcriptFrameChanged(painted, { revision: 8, wait: '' })).toBe(true)
  })
})
