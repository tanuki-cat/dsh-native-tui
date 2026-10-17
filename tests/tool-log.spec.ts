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
})