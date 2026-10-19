import { describe, expect, it } from 'vitest'
import { asFileDiffs, diffLines, resultFileDiffs } from '../src/ui/diff.js'

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

describe('resultFileDiffs', () => {
  it('prefers the recorded hunk diffs', () => {
    expect(resultFileDiffs({
      operation: 'update',
      diffs: [{ path: 'a.txt', oldText: 'a', newText: 'b' }],
    }, JSON.stringify({ file_path: 'a.txt', content: 'ignored' }))).toEqual([
      { path: 'a.txt', oldText: 'a', newText: 'b' },
    ])
  })

  it('rebuilds a create from the write arguments', () => {
    expect(resultFileDiffs(
      { operation: 'create', path: 'dir/new.txt', diffs: [] },
      JSON.stringify({ file_path: 'new.txt', content: 'one\ntwo' }),
    )).toEqual([{ path: 'new.txt', oldText: null, newText: 'one\ntwo' }])
  })

  it('does not invent a diff for an empty update or missing arguments', () => {
    expect(resultFileDiffs({ operation: 'update', diffs: [] }, JSON.stringify({ file_path: 'a.txt', content: 'x' }))).toBeUndefined()
    expect(resultFileDiffs({ operation: 'create', diffs: [] }, 'not json')).toBeUndefined()
    expect(resultFileDiffs({ operation: 'create' }, JSON.stringify({ file_path: 'a.txt' }))).toBeUndefined()
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
