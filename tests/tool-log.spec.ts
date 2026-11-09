import { describe, expect, it } from 'vitest'
import { collectToolCalls } from '../src/runtime/tool-log.js'

const events = [
  { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
  { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'line one' }] }, meta: { diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] } } },
  { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'boom' }], isError: true } } },
]

describe('collectToolCalls', () => {
  it('pairs calls with results and preserves order', () => {
    expect(collectToolCalls(events)).toEqual([
      { callId: 'c1', name: 'read', args: '{"path":"a.ts"}', result: 'line one', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      { callId: 'c2', name: 'bash', args: '{"command":"ls"}', result: 'boom', isError: true },
    ])
  })

  it('keeps the newest calls up to the cap', () => {
    const rows = collectToolCalls(events, 1)
    expect(rows.map(row => row.callId)).toEqual(['c2'])
  })

  it('preserves the original native result when a replay follows it', () => {
    const replay = { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'REPLAY' }] } } }
    expect(collectToolCalls([...events, events[0]!, replay])[0]).toMatchObject({ result: 'line one' })
  })
})

const ptcArgs = { file_path: 'a.ts', content: 'after' }
const ptcDiff = { path: 'a.ts', oldText: 'before', newText: 'after' }
const ptcStart = (subCallId = 'nested', args: unknown = ptcArgs) => ({
  type: 'tool/ptc-dispatch-start', data: { parentCallId: 'outer', subCallId, name: 'write', arguments: args },
})
const ptcResult = (subCallId = 'nested', extra: Record<string, unknown> = {}) => ({
  type: 'tool/ptc-dispatch', data: { parentCallId: 'outer', subCallId, name: 'write', arguments: ptcArgs,
    content: [{ type: 'text', text: 'Updated file' }], meta: { diffs: [ptcDiff] }, ...extra },
})

describe('PTC tool log collection', () => {
  it.each([ptcArgs, JSON.stringify(ptcArgs)])('pairs nested calls with results and normalizes arguments: %s', args => {
    expect(collectToolCalls([ptcStart('nested', args), ptcResult('nested', { arguments: args })])).toEqual([
      { callId: 'nested', name: 'write', args: JSON.stringify(ptcArgs), result: 'Updated file', diffs: [ptcDiff] },
    ])
  })

  it('keeps a PTC result whose start is outside the retained window', () => {
    expect(collectToolCalls([ptcResult()])[0]).toMatchObject({
      callId: 'nested', name: 'write', args: JSON.stringify(ptcArgs), diffs: [ptcDiff],
    })
  })

  it('preserves call order across native parents, nested tools and later native tools', () => {
    const calls = [events[0]!, ptcStart(), events[2]!, ptcResult(), events[1]!]
    expect(collectToolCalls(calls).map(call => call.callId)).toEqual(['c1', 'nested', 'c2'])
    expect(collectToolCalls(calls, 2).map(call => call.callId)).toEqual(['nested', 'c2'])
  })

  it('does not replace the first settled result during replay, including empty results', () => {
    const first = ptcResult('nested', { isError: true, content: [], arguments: undefined })
    const rows = collectToolCalls([ptcStart(), first, ptcStart(), ptcResult()])
    expect(rows).toEqual([{ callId: 'nested', name: 'write', args: JSON.stringify(ptcArgs),
      result: '', isError: true, diffs: [ptcDiff] }])
  })

  it('preserves partial changes and error text', () => {
    expect(collectToolCalls([ptcResult('nested', { isError: true, content: [{ type: 'text', text: 'Partial failure' }],
      meta: { stopped: true, diffs: [ptcDiff] } })])[0]).toMatchObject({
      result: 'Partial failure', isError: true, diffs: [ptcDiff],
    })
  })

  it('ignores malformed dispatches and leaves valid calls readable', () => {
    const rows = collectToolCalls([
      { type: 'tool/ptc-dispatch', data: null },
      { type: 'tool/ptc-dispatch-start', data: { name: 'write' } },
      ptcStart('nested', 'not JSON'),
      ptcResult('nested', { arguments: undefined, meta: { diffs: [{ path: 1 }] } }),
    ])
    expect(rows).toEqual([{ callId: 'nested', name: 'write', args: 'not JSON', result: 'Updated file' }])
  })
})
