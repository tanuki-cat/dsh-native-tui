import { describe, expect, it } from 'vitest'
import { asFileDiffs, diffLines } from '../src/ui/diff.js'

describe('asFileDiffs', () => {
  it('accepts the write/edit metadata envelope', () => {
    expect(asFileDiffs({ diffs: [{ path: 'a.txt', oldText: 'a', newText: 'b' }] })).toEqual([
      { path: 'a.txt', oldText: 'a', newText: 'b' },
    ])
  })

  it('rejects empty or malformed envelopes', () => {
    expect(asFileDiffs(undefined)).toBeUndefined()
    expect(asFileDiffs({})).toBeUndefined()
    expect(asFileDiffs({ diffs: [] })).toBeUndefined()
    expect(asFileDiffs({ diffs: [{ path: 1, oldText: 'a', newText: 'b' }] })).toBeUndefined()
  })
})

describe('diffLines', () => {
  it('emits context plus one removal and one addition', () => {
    const rows = diffLines('a\nb\nc', 'a\nx\nc')
    expect(rows[0]).toEqual({ kind: 'context', text: 'a' })
    expect(rows.some(row => row.kind === 'remove' && row.text === 'b')).toBe(true)
    expect(rows.some(row => row.kind === 'add' && row.text === 'x')).toBe(true)
    expect(rows.at(-1)).toEqual({ kind: 'context', text: 'c' })
  })

  it('treats null old text as a created file', () => {
    expect(diffLines(null, 'one\ntwo')).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ])
  })

  it('caps large diffs and marks the omission', () => {
    const rows = diffLines(null, Array.from({ length: 20 }, (_, index) => 'line' + String(index)).join('\n'), 5)
    expect(rows).toHaveLength(5)
    expect(rows.at(-1)?.kind).toBe('context')
    expect(rows.at(-1)?.text).toContain('lines omitted')
  })
})
