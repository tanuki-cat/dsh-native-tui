import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { approvalReceipt } from '../src/ui/approval-preview.js'
import { reduceTranscript, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100, runCodeDisplay: 'compact' as const }
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 0 } as unknown as SessionEvent,
})
const output = (renderer: TranscriptRenderer) => stripTerminalSequences(renderer.container.render(120).join('\n'))
const tools = (entries: readonly TranscriptEntry[]) => reduceTranscript(entries, options).filter(block => block.kind === 'tool')

function fixture(ptc: boolean, name: 'bash' | 'edit') {
  const entries: TranscriptEntry[] = []
  const add = (type: string, data: unknown): number => { const seq = entries.length + 1; entries.push(event(type, data, seq)); return seq }
  const args = JSON.stringify(name === 'bash' ? { command: 'printf ORDER_PROBE' } : { file_path: 'scope.ts', old_string: 'BEFORE', new_string: 'AFTER' })
  add('turn/start', { turn: 1 })
  add('user/message', { content: [{ type: 'text', text: 'order probe' }], source: { kind: 'user' } })
  const rootSeq = ptc ? add('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{"description":"ORDER_ROOT","code":"return 1"}' }) : undefined
  const dispatch = { parentCallId: 'root', rootCallId: 'root', subCallId: 'call', name, arguments: args }
  const callSeq = ptc ? add('tool/ptc-dispatch-start', dispatch)
    : add('tool/call', { turn: 1, step: 1, callId: 'call', name, arguments: args })
  const askedSeq = add('approval/asked', { id: 'approval', toolName: name, callId: 'call' })
  return { entries, add, args, dispatch, rootSeq, callSeq, askedSeq }
}

describe.each([false, true])('approval ordering (PTC: %s)', ptc => {
  describe.each(['bash', 'edit'] as const)('%s lifecycle', name => {
    it.each(['allowed-once', 'rejected', 'cancelled'] as const)('keeps the receipt after its tool across %s and replay', outcome => {
      const h = fixture(ptc, name), renderer = new TranscriptRenderer(options)
      renderer.set(h.entries, [])
      const component = renderer.container.children[2]
      const receipt = approvalReceipt(name, h.args, outcome)
      const notices: TranscriptBlock[] = [{ kind: 'notice', ...receipt, afterSeq: h.askedSeq }]
      const assertOrder = (renderer: TranscriptRenderer): void => {
        const rows = output(renderer).split('\n')
        const receiptRow = rows.findIndex(row => row.includes(receipt.text))
        const callRow = rows.findIndex(row => ptc ? row.includes('code · ORDER_ROOT')
          : name === 'bash' ? /^• (?:Running|Ran) printf ORDER_PROBE/u.test(row) : /^• Edit(?:ed| )/u.test(row))
        expect(callRow).toBeGreaterThanOrEqual(0)
        expect(receiptRow).toBeGreaterThan(callRow)
        if (ptc && name === 'edit') expect(receiptRow).toBeGreaterThan(rows.findIndex(row => /^• Edit(?:ed| )/u.test(row)))
      }
      renderer.set(h.entries, notices)
      assertOrder(renderer)
      h.add('approval/decided', { id: 'approval', outcome })
      renderer.set(h.entries, notices)
      assertOrder(renderer)
      const content = [{ type: 'text', text: outcome === 'allowed-once' ? 'EXECUTION_DONE' : 'EXECUTION_DECLINED' }]
      const isError = outcome !== 'allowed-once'
      const meta = name === 'edit' && !isError ? { diffs: [{ path: 'scope.ts', oldText: 'BEFORE', newText: 'AFTER' }] } : undefined
      const resultSeq = ptc ? h.add('tool/ptc-dispatch', { ...h.dispatch, content, isError, meta })
        : h.add('tool/result', { turn: 1, step: 1, message: { source: { callId: 'call' }, content, isError }, meta })
      renderer.set(h.entries, notices)
      assertOrder(renderer)
      expect(tools(h.entries).find(block => block.callId === 'call') ?? tools(h.entries)[0]).toMatchObject({
        seq: ptc && name === 'bash' ? h.rootSeq : resultSeq,
        positionSeq: ptc && name === 'bash' ? h.rootSeq : h.callSeq,
      })
      if (ptc) {
        const parentResult = h.add('tool/result', { turn: 1, step: 1, message: { source: { callId: 'root' }, content, isError } })
        renderer.set(h.entries, notices)
        assertOrder(renderer)
        expect(tools(h.entries)[0]).toMatchObject({ seq: parentResult, positionSeq: h.rootSeq })
      }
      expect(renderer.container.children[2]).toBe(component)
      const replay = new TranscriptRenderer(options)
      replay.set(h.entries, notices)
      assertOrder(replay)
      expect(output(replay)).toBe(output(renderer))
    })
  })

  it('uses the first retained result when its call/start is missing', () => {
    const content = [{ type: 'text', text: 'ORPHAN_RESULT' }]
    const result = ptc ? event('tool/ptc-dispatch', { subCallId: 'orphan', name: 'edit', arguments: '{}', content }, 9)
      : event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'orphan' }, content } }, 9)
    expect(tools([result])[0]).toMatchObject({ seq: 9, positionSeq: 9 })
    const renderer = new TranscriptRenderer(options)
    renderer.set([result], [{ kind: 'notice', tone: 'info', text: 'EARLIER_RECEIPT', afterSeq: 8 }])
    expect(output(renderer).indexOf('EARLIER_RECEIPT')).toBeLessThan(output(renderer).indexOf('ORPHAN_RESULT'))
  })

  it('keeps a partially stopped edit below its call and above the approval receipt', () => {
    const h = fixture(ptc, 'edit'), renderer = new TranscriptRenderer(options)
    const notices: TranscriptBlock[] = [{ kind: 'notice', ...approvalReceipt('edit', h.args, 'allowed-once'), afterSeq: h.askedSeq }]
    renderer.set(h.entries, notices)
    const content = [{ type: 'text', text: 'PARTIAL_DIAGNOSTIC' }]
    const meta = { stopped: true, diffs: [{ path: 'scope.ts', oldText: 'BEFORE', newText: 'AFTER' }] }
    const resultSeq = ptc ? h.add('tool/ptc-dispatch', { ...h.dispatch, content, meta })
      : h.add('tool/result', { turn: 1, step: 1, message: { source: { callId: 'call' }, content }, meta })
    renderer.set(h.entries, notices)
    const rendered = output(renderer)
    expect(rendered).toContain('PARTIAL_DIAGNOSTIC')
    expect(rendered).toContain('1 + AFTER')
    expect(rendered.indexOf('You approved')).toBeGreaterThan(rendered.indexOf('PARTIAL_DIAGNOSTIC'))
    expect(tools(h.entries).find(block => block.callId === 'call')).toMatchObject({ stopped: true, seq: resultSeq, positionSeq: h.callSeq })
  })
})

it('keeps concurrent tool calls and receipts in place when results arrive in reverse order', () => {
  const entries = [
    event('tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"command":"printf ORDER_A"}' }, 1),
    event('approval/asked', { id: 'a', toolName: 'bash', callId: 'a' }, 2),
    event('tool/call', { turn: 1, step: 1, callId: 'b', name: 'bash', arguments: '{"command":"printf ORDER_B"}' }, 3),
    event('approval/asked', { id: 'b', toolName: 'bash', callId: 'b' }, 4),
  ]
  const notices: TranscriptBlock[] = [
    { kind: 'notice', tone: 'success', text: 'RECEIPT_A', afterSeq: 2 },
    { kind: 'notice', tone: 'success', text: 'RECEIPT_B', afterSeq: 4 },
  ]
  const renderer = new TranscriptRenderer(options)
  const assertOrder = (): void => {
    renderer.set(entries, notices)
    const rendered = output(renderer)
    const positions = ['printf ORDER_A', 'RECEIPT_A', 'printf ORDER_B', 'RECEIPT_B'].map(value => rendered.indexOf(value))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  }
  assertOrder()
  for (const [index, callId] of ['b', 'a'].entries()) {
    entries.push(event('tool/result', { turn: 1, step: 1, message: { source: { callId }, content: [] } }, index + 5))
    assertOrder()
  }
  expect(tools(entries)).toMatchObject([{ seq: 6, positionSeq: 1 }, { seq: 5, positionSeq: 3 }])
})

it('keeps the approval receipt as a boundary between successful file edit groups', () => {
  const h = fixture(false, 'edit'), renderer = new TranscriptRenderer(options)
  const notices: TranscriptBlock[] = [{ kind: 'notice', ...approvalReceipt('edit', h.args, 'allowed-once'), afterSeq: h.askedSeq }]
  h.add('tool/result', { turn: 1, step: 1, message: { source: { callId: 'call' }, content: [] }, meta: {
    diffs: [{ path: 'scope.ts', oldText: 'BEFORE', newText: 'AFTER' }],
  } })
  h.add('tool/call', { turn: 1, step: 2, callId: 'next', name: 'edit', arguments: '{"file_path":"next.ts"}' })
  h.add('tool/result', { turn: 1, step: 2, message: { source: { callId: 'next' }, content: [] }, meta: {
    diffs: [{ path: 'next.ts', oldText: 'OLD', newText: 'NEW' }],
  } })
  renderer.set(h.entries, notices)
  const rendered = output(renderer)
  expect(rendered.match(/• Edited 1 file/gu)).toHaveLength(2)
  expect(rendered.indexOf('You approved')).toBeGreaterThan(rendered.indexOf('scope.ts'))
  expect(rendered.indexOf('You approved')).toBeLessThan(rendered.indexOf('next.ts'))
})

it('keeps an approval receipt after a retained tool when the history window is trimmed and rebuilt', () => {
  const h = fixture(false, 'bash'), renderer = new TranscriptRenderer({ ...options, maxEntries: 1 })
  const notices: TranscriptBlock[] = [{ kind: 'notice', tone: 'success', text: 'TRIM_RECEIPT', afterSeq: h.askedSeq }]
  h.add('tool/result', { turn: 1, step: 1, message: { source: { callId: 'call' }, content: [{ type: 'text', text: 'DONE' }] } })
  const assertOrder = (): void => {
    const rendered = output(renderer)
    expect(rendered.indexOf('TRIM_RECEIPT')).toBeGreaterThan(rendered.indexOf('printf ORDER_PROBE'))
    expect(rendered.indexOf('printf ORDER_PROBE')).toBeGreaterThanOrEqual(0)
  }
  renderer.set(h.entries, notices)
  assertOrder()
  expect(renderer.retainedFrom).toBeGreaterThan(0)
  renderer.set(h.entries.slice(renderer.retainedFrom), notices)
  assertOrder()
  renderer.setMaxEntries(2)
  assertOrder()
})
