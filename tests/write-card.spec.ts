import { describe, expect, it } from 'vitest'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock, TranscriptEntry } from '../src/ui/transcript.js'

const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }
type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const write = (content: string, overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool', callId: 'write-1', name: 'write', pending: false,
  args: JSON.stringify({ file_path: 'example.ts', content }),
  diffs: [{ path: 'example.ts', oldText: 'previous content', newText: content }],
  result: 'Created file', ...overrides,
})
const render = (block: ToolBlock, expanded = false): string => renderTranscriptBlock(block, { ...options, writeExpanded: expanded }).render(120).join('\n')

describe('write content cards', () => {
  it('shows a file header and source preview, not a diff or duplicate success output', () => {
    const text = render(write('const answer = 42'))
    expect(text).toContain('write example.ts')
    expect(text).toContain('const answer = 42')
    for (const hidden of ['diff ', '│ +', '│ -', 'previous content', '├ args', '├ result', 'Created file', '└ done']) expect(text).not.toContain(hidden)
  })

  it('collapses to ten source lines with a truthful expansion hint', () => {
    const content = Array.from({ length: 83 }, (_, index) => 'SOURCE_LINE_' + String(index + 1).padStart(3, '0')).join('\n') + '\n\n'
    const text = render(write(content))
    expect(text).toContain('SOURCE_LINE_010')
    expect(text).not.toContain('SOURCE_LINE_011')
    expect(text).toContain('73 more lines, 83 total, ctrl+o to expand')
    const expanded = render(write(content), true)
    expect(expanded).toContain('SOURCE_LINE_083')
    expect(expanded).toContain('ctrl+o to collapse')
    expect(expanded).not.toContain('more lines')
  })

  it('highlights supported code while preserving its visible content', () => {
    const colored = createPalette('dark')
    const component = renderTranscriptBlock(write("const message = 'hello'"), { ...options, palette: colored })
    const text = component.render(120).join('\n')
    expect(text).toContain(colored.accent('const'))
    expect(text).toContain(colored.success("'hello'"))
    expect(text.replace(/\x1b\[[0-9;]*m/g, '')).toContain("const message = 'hello'")
  })

  it('does not highlight plain mode or guess a language for text files', () => {
    const source = "const message = 'hello'"
    expect(render(write(source))).not.toContain('\x1b')
    const colored = createPalette('dark')
    const text = renderTranscriptBlock(write(source, { args: JSON.stringify({ path: 'notes.txt', content: source }) }), { ...options, palette: colored }).render(120).join('\n')
    expect(text).toContain(source)
    expect(text).not.toContain(colored.accent('const'))
  })

  it('keeps the header and preview stable from pending through success', () => {
    const content = 'line\n'.repeat(83)
    const pending = renderTranscriptBlock(write(content, { pending: true, result: undefined, diffs: undefined }), options).render(120)
    const settled = renderTranscriptBlock(write(content), options).render(120)
    expect(pending[0]).toBe(settled[0])
    expect(pending.slice(0, settled.length)).toEqual(settled)
    expect(pending.at(-1)).toContain('running…')
  })

  it('preserves write errors and empty files', () => {
    const error = render(write('content', { isError: true, result: 'Permission denied' }))
    expect(error).toContain('Permission denied')
    expect(error).toContain('└ error')
    expect(error).not.toContain('│ +')
    const empty = render(write(''))
    expect(empty).toContain('write example.ts')
    expect(empty).not.toContain('more lines')
  })

  it('uses durable content when call arguments are unavailable and reports invalid content otherwise', () => {
    const fallback = render(write('recovered', { args: 'invalid JSON' }))
    expect(fallback).toContain('write example.ts')
    expect(fallback).toContain('recovered')
    const invalid = render(write('', { args: '{"file_path":"bad.ts","content":42}', diffs: undefined }))
    expect(invalid).toContain('write bad.ts')
    expect(invalid).toContain('expected string')
  })

  it('normalizes tabs and CRLF and escapes terminal control sequences in source', () => {
    const text = render(write('first\r\n\tsecond\n\x1b]52;clipboard\x07'))
    expect(text).toContain('  second')
    expect(text).not.toContain('\r')
    expect(text).not.toContain('\x1b')
    expect(text).toContain('\\x1b]52;clipboard\\x07')
    const path = render(write('safe', { args: JSON.stringify({ file_path: 'evil\x1b]52;clipboard\x07.ts', content: 'safe' }) }))
    expect(path).not.toContain('\x1b')
    expect(path).toContain('evil\\x1b]52;clipboard\\x07.ts')
  })

  it('toggles and restores collapsed write previews without changing edit diffs', () => {
    const content = Array.from({ length: 30 }, (_, index) => 'CODE_LINE_' + index).join('\n')
    const renderer = new TranscriptRenderer(options)
    const entries: TranscriptEntry[] = [{ type: 'event', event: {
      type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'write-1', name: 'write', arguments: JSON.stringify({ file_path: 'example.ts', content }) },
    } } as never]
    renderer.set(entries, [{ kind: 'tool', callId: 'edit-1', name: 'edit', args: '{"file_path":"edit.ts"}', pending: false, diffs: [{ path: 'edit.ts', oldText: 'old', newText: 'new' }] }])
    const output = () => renderer.container.render(120).join('\n')
    expect(output()).not.toContain('CODE_LINE_29')
    const editComponent = renderer.container.children.at(-1)
    renderer.toggleWritePreview()
    expect(renderer.container.children.at(-1)).toBe(editComponent)
    expect(output()).toContain('CODE_LINE_29')
    expect(output()).toContain('diff edit.ts')
    expect(output()).toContain('│ + new')
    renderer.toggleWritePreview()
    expect(output()).not.toContain('CODE_LINE_29')
    expect(output()).toContain('ctrl+o to expand')
  })
})
