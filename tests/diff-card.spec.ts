import { describe, expect, it } from 'vitest'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }
const card = (overrides: Partial<Extract<TranscriptBlock, { kind: 'tool' }>> = {}): Extract<TranscriptBlock, { kind: 'tool' }> => ({
  kind: 'tool', callId: 'c1', name: 'edit', pending: false,
  args: JSON.stringify({ file_path: 'src/example.ts', old_string: 'before', new_string: 'after' }),
  result: 'Successfully updated src/example.ts',
  diffs: [{ path: 'src/example.ts', oldText: 'before', newText: 'after' }],
  ...overrides,
})
const render = (block: TranscriptBlock, width = 100): string => renderTranscriptBlock(block, options).render(width).join('\n')

describe('file diff cards', () => {
  it.each(['edit', 'custom-tool'])('renders only file and diff rows for %s', name => {
    const output = render(card({ name }))
    expect(output).toContain('diff src/example.ts')
    expect(output).toContain('│ - before')
    expect(output).toContain('│ + after')
    for (const hidden of ['⚙', '├ args', '├ result', '├ diff', 'Successfully updated', '└ done', 'old_string', 'new_string']) {
      expect(output).not.toContain(hidden)
    }
  })

  it('shows new file contents only once', () => {
    const output = render(card({ name: 'write', args: '{"file_path":"src/example.ts","content":"UNIQUE-CONTENT"}',
      result: 'Created file', diffs: [{ path: 'src/example.ts', oldText: null, newText: 'UNIQUE-CONTENT' }],
    }))
    expect(output.match(/UNIQUE-CONTENT/g)).toHaveLength(1)
    expect(output).not.toContain('Created file')
  })

  it('keeps pending file calls short and their header stable when the diff arrives', () => {
    const pending = card({ pending: true, result: undefined, diffs: undefined,
      args: JSON.stringify({ file_path: 'src/example.ts', content: 'huge body\n'.repeat(1_000) }),
    })
    const before = renderTranscriptBlock(pending, options).render(100)
    const after = renderTranscriptBlock(card(), options).render(100)
    expect(before[0]).toBe(after[0])
    expect(before.length).toBeLessThanOrEqual(2)
    expect(before.join('\n')).toContain('running…')
    expect(before.join('\n')).not.toContain('huge body')
  })

  it('keeps execution errors visible even when a diff is present', () => {
    const output = render(card({ isError: true, result: 'Permission denied' }))
    expect(output).toContain('Permission denied')
    expect(output).toContain('│ + after')
    expect(output).toContain('error')
    expect(output).not.toContain('├ args')
  })

  it('preserves a result when no diff metadata is available', () => {
    const output = render(card({ diffs: [], result: 'No changes were necessary' }))
    expect(output).toContain('No changes were necessary')
    expect(output).not.toContain('old_string')
  })

  it('renders every file and keeps long diffs bounded', () => {
    const output = render(card({ diffs: [
      { path: 'one.ts', oldText: null, newText: Array.from({ length: 100 }, (_, index) => 'line ' + index).join('\n') },
      { path: 'two.ts', oldText: 'old', newText: 'new' },
    ] }))
    expect(output).toContain('diff one.ts')
    expect(output).toContain('diff two.ts')
    expect(output).toContain('lines omitted')
    expect(output).toContain('│ + new')
    expect(output).not.toContain('diff src/example.ts')
  })

  it('leaves non-file tools and malformed-argument fallbacks readable', () => {
    const generic = render(card({ name: 'read', diffs: undefined, result: 'file contents' }))
    expect(generic).toContain('⚙ read')
    expect(generic).toContain('├ args')
    expect(generic).toContain('file contents')
    const malformed = render(card({ args: 'not JSON', diffs: undefined, isError: true, result: 'Invalid arguments' }))
    expect(malformed).toContain('not JSON')
    expect(malformed).toContain('Invalid arguments')
  })
})
