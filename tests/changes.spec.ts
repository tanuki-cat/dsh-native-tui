import { describe, expect, it } from 'vitest'
import { formatChangesSummary, formatWorkspaceDiff } from '../src/runtime/changes.js'

describe('formatChangesSummary', () => {
  it('lists indexed files with counts and totals', () => {
    const text = formatChangesSummary({
      turn: 2,
      cwd: '/workspace',
      total: 3,
      added: 5,
      deleted: 2,
      files: [
        { display: 'src/a.ts', added: 3, deleted: 1 },
        { display: 'bin.dat', added: 0, deleted: 0, binary: true },
      ],
    })
    expect(text).toContain('turn 2')
    expect(text).toContain('0. src/a.ts  +3 -1')
    expect(text).toContain('1. bin.dat  binary')
    expect(text).toContain('1 more file(s)')
  })
})

describe('formatWorkspaceDiff', () => {
  it('renders hunk headers and body lines', () => {
    const text = formatWorkspaceDiff({
      kind: 'text',
      display: 'a.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    })
    expect(text).toContain('diff a.ts')
    expect(text).toContain('@@ -1,1 +1,1 @@')
    expect(text).toContain('-old')
    expect(text).toContain('+new')
  })

  it('labels binary and oversized comparisons', () => {
    expect(formatWorkspaceDiff({ kind: 'binary', display: 'x.bin' })).toBe('diff x.bin · binary')
    expect(formatWorkspaceDiff({ kind: 'oversized', display: 'x.log' })).toBe('diff x.log · oversized')
  })
})
