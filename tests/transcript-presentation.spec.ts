import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock, TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { SourcePreview } from '../src/ui/source-preview.js'
import { diffLines } from '../src/ui/diff.js'

const palette = createPalette('plain')
const tool = (overrides: Partial<Extract<TranscriptBlock, { kind: 'tool' }>> = {}): Extract<TranscriptBlock, { kind: 'tool' }> => ({
  kind: 'tool', callId: 'call-1', name: 'bash', args: '{"command":"pnpm check"}', pending: false, result: 'PASS', ...overrides,
})
const render = (block: TranscriptBlock, theme: 'plain' | 'dark' | 'light' = 'plain', width = 100) => {
  const palette = createPalette(theme)
  return renderTranscriptBlock(block, { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }).render(width)
}

describe('compact transcript presentation', () => {
  it.each(['dark', 'light', 'plain'] as const)('uses quiet compaction progress and truthful receipts in %s', theme => {
    const labels = { running: 'Compacting…', done: 'Context compacted', error: 'Failed to compact context', interrupted: 'Interrupted while compacting context' }
    let heading: string | undefined
    for (const state of ['running', 'done', 'error', 'interrupted'] as const) {
      const rows = render({ kind: 'compaction', compactionId: 'c', state, summary: 'Summary',
        ...(state === 'error' ? { error: 'Failure detail' } : {}),
      }, theme, 60)
      heading ??= rows[0]
      expect(rows[0]).toBe(heading)
      const plain = rows.map(stripTerminalSequences).join('\n')
      expect(plain).toContain('• Compact context')
      expect(plain).toContain('  Summary')
      expect(plain).toContain(labels[state])
      expect(plain).not.toMatch(/◆|⟳|✓ done|│/u)
      if (state === 'error') expect(plain).toContain('Failure detail')
      if (state === 'interrupted') expect(plain).toContain('Stopped before it committed')
      expect(rows.every(row => visibleWidth(row) <= 60)).toBe(true)
      if (theme === 'plain') expect(rows.join('\n')).not.toContain('\x1b')
    }
  })

  it.each(['dark', 'light'] as const)('uses a neutral padded user surface and plain Markdown hierarchy in %s', theme => {
    const palette = createPalette(theme)
    const lines = render({ kind: 'user', text: 'Please review\nsecond line' }, theme, 60)
    const plain = lines.map(stripTerminalSequences)
    expect(plain[0]?.trim()).toBe('')
    expect(plain[1]).toContain('› Please review')
    expect(plain[2]).toContain('  second line')
    expect(plain.at(-1)?.trim()).toBe('')
    expect(lines.join('\n')).toContain(theme === 'dark' ? '48;5;238' : '48;5;255')
    expect(lines.join('\n')).not.toContain('48;5;23m')
    expect(markdownTheme(palette).heading('Heading')).toBe(palette.bold('Heading'))
    expect(lines.every(line => visibleWidth(line) <= 60)).toBe(true)
  })
  it('puts shell output under a heading whose tense follows execution state', () => {
    const lines = render(tool(), 'dark')
    expect(lines.map(stripTerminalSequences).map(line => line.trimEnd())).toEqual(['• Ran pnpm check', '  └ PASS'])
    expect(lines.join('\n')).not.toContain('48;5;237')
    for (const update of [{ pending: true }, { isError: true }, { stopped: true }]) {
      const rows = render(tool(update), 'dark').map(stripTerminalSequences)
      expect(rows[0]).toBe('pending' in update ? '• Running pnpm check' : '• Ran pnpm check')
      expect(rows.join('\n')).not.toContain('└ running…')
    }
  })

  it.each(['bash', 'pwsh', 'read', 'write', 'edit', 'mcp__idea__lookup', 'run_code'])('preserves the %s marker semantics through its lifecycle, including empty results', name => {
    for (const theme of ['dark', 'light'] as const) {
      const palette = createPalette(theme)
      for (const runCodeDisplay of ['compact', 'detailed'] as const) {
        for (const toolsExpanded of [false, true]) {
          const block = tool({ name, args: JSON.stringify({ command: 'pwd', code: 'return 1', file_path: 'a.ts', content: 'one' }), result: '' })
          let heading: string | undefined
          for (const [state, color] of [
            [{ pending: true }, palette.warning],
            [{ pending: false }, palette.success],
            [{ pending: false, isError: true }, palette.error],
            [{ pending: false, stopped: true }, palette.dim],
            [{ pending: false, isError: true, stopped: true }, palette.error],
          ] as const) {
            const rows = renderTranscriptBlock({ ...block, ...state }, {
              palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100, runCodeDisplay, toolsExpanded,
            }).render(100)
            const marker = color('• ')
            expect(rows[0]!.startsWith(marker)).toBe(true)
            const title = rows[0]!.slice(marker.length).replace('Running ', 'Ran ')
            heading ??= title
            expect(title).toBe(heading)
            expect(rows.join('\n')).not.toContain('✓ done')
          }
        }
      }
    }
  })

  it('shows reasoning as dim italic text and Markdown answers without an assistant label', () => {
    const lines = render({ kind: 'assistant', text: '**Answer**', reasoning: 'Inspect the source', live: true }, 'dark')
    const text = stripTerminalSequences(lines.join('\n'))
    expect(text).toContain('  Inspect the source')
    expect(text).toContain('• Answer')
    expect(text.indexOf('Inspect')).toBeLessThan(text.indexOf('Answer'))
    expect(text).not.toContain('assistant')
    expect(lines.join('\n')).toContain('\u001B[3m')
    expect(lines.join('\n')).not.toContain('48;5;235')
  })

  it('numbers written source and preserves indentation across wrapped continuations', () => {
    const preview = new SourcePreview('first\n    indented line with several words', undefined, palette)
    const lines = preview.render(18).map(line => line.trimEnd())
    expect(lines[0]).toBe('1  first')
    expect(lines[1]).toMatch(/^2 {6}indented/u)
    expect(lines.slice(2).every(line => line.startsWith('   '))).toBe(true)
    expect(lines.every(line => visibleWidth(line) <= 18)).toBe(true)
  })

  it('keeps blank source lines numbered and carries multiline syntax colors across lines', () => {
    expect(new SourcePreview('first\n\nthird', undefined, palette).render(40).map(line => line.trimEnd()))
      .toEqual(['1  first', '2', '3  third'])
    const lines = new SourcePreview('/* first\nsecond */', 'typescript', createPalette('dark')).render(40)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('\u001B[2m')
    expect(stripTerminalSequences(lines[1]!)).toContain('second */')
  })

  it('keeps native and PTC file calls visually consistent', () => {
    const file = tool({ name: 'edit', args: '{"file_path":"src/a.ts"}',
      diffs: [{ path: 'src/a.ts', oldText: 'before\n', newText: 'after\n' }] })
    const text = render(file).join('\n')
    expect(text).toContain('• Edit src/a.ts')
    expect(text).toContain('(+1 -1)')
    expect(text).toContain('1 - before')
    expect(text).toContain('1 + after')
  })

  it.each([1, 12, 32, 80, 160])('bounds all presentation rows to %i columns in each theme', width => {
    for (const theme of ['plain', 'dark', 'light'] as const) {
      const blocks: TranscriptBlock[] = [
        tool({ args: JSON.stringify({ command: 'printf 你好👩‍💻', workdir: '/tmp/中文' }), result: '你好👩‍💻'.repeat(12) }),
        tool({ name: 'write', args: JSON.stringify({ file_path: '/very/long/中文👩‍💻/a.ts', content: '你好👩‍💻'.repeat(12) }) }),
        tool({ name: 'edit', args: '{"file_path":"a.ts"}', diffs: [{ path: 'a.ts', oldText: '原始'.repeat(20), newText: '修改'.repeat(20) }] }),
        { kind: 'assistant', text: '正文👩‍💻'.repeat(12), reasoning: '思考👩‍💻'.repeat(12), live: true },
      ]
      for (const block of blocks) {
        const rows = render(block, theme, width)
        expect(rows.every(line => visibleWidth(line) <= width)).toBe(true)
        if (theme === 'plain') expect(rows.join('\n')).not.toContain('\u001B')
      }
    }
  })
})

describe.each(['native', 'ptc'] as const)('%s tool result marker projection', mode => {
  it.each(['success', 'failure', 'stopped'] as const)('settles an empty %s result through the cached renderer', outcome => {
    const palette = createPalette('dark')
    const renderer = new TranscriptRenderer({ palette, markdown: markdownTheme(palette), showReasoning: true,
      maxEntries: 100, runCodeDisplay: 'compact' })
    const args = JSON.stringify({ file_path: 'a.ts', old_string: 'before', new_string: 'after' })
    const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
      type: 'event', event: { type, data, seq, time: 0 } as never,
    })
    const call = { name: 'edit', callId: 'file', subCallId: 'file', parentCallId: 'outer', arguments: args }
    const entries = [event(mode === 'native' ? 'tool/call' : 'tool/ptc-dispatch-start', call, 1)]
    renderer.setEntries(entries)
    const component = renderer.container.children[0]
    const pending = renderer.container.render(100)[0]!
    expect(pending.startsWith(palette.warning('• '))).toBe(true)
    const result = { isError: outcome === 'failure', content: [], meta: { stopped: outcome === 'stopped' } }
    entries.push(mode === 'native'
      ? event('tool/result', { message: { source: { callId: 'file' }, content: result.content, isError: result.isError }, meta: result.meta }, 2)
      : event('tool/ptc-dispatch', { ...call, ...result }, 2))
    renderer.setEntries(entries)
    expect(renderer.container.children[0]).toBe(component)
    const settled = renderer.container.render(100)
    const color = outcome === 'failure' ? palette.error : outcome === 'stopped' ? palette.dim : palette.success
    expect(settled[0]!.startsWith(color('• '))).toBe(true)
    expect(stripTerminalSequences(settled[0]!)).toBe(stripTerminalSequences(pending))
    expect(settled.join('\n')).not.toContain('running…')
    expect(settled.join('\n')).not.toContain('✓ done')
    if (outcome === 'success') expect(settled).toHaveLength(1)
    else expect(settled.at(-1)).toContain(outcome === 'failure' ? 'error' : 'stopped')
  })
})

describe('applied diff accounting', () => {
  it('does not count empty files or a final newline as inserted source lines', () => {
    expect(diffLines(null, '')).toEqual([])
    expect(diffLines(null, 'one\n')).toEqual([{ kind: 'add', text: 'one' }])
    expect(diffLines('one\n', '')).toEqual([{ kind: 'remove', text: 'one' }])
    expect(diffLines('one\n\n', 'one\n')).toEqual([{ kind: 'context', text: 'one' }, { kind: 'remove', text: '' }])
  })

  it('counts changes before folding the preview and tints only changed rows', () => {
    const file = tool({ name: 'edit', args: '{"file_path":"a.ts"}', diffs: [{ path: 'a.ts', oldText: null,
      newText: Array.from({ length: 100 }, (_, index) => 'LINE_' + index).join('\n') + '\n' }] })
    const lines = render(file, 'dark', 80)
    expect(stripTerminalSequences(lines.join('\n'))).toContain('(+100 -0)')
    expect(lines.some(line => line.includes('48;5;22') && line.includes('LINE_0'))).toBe(true)
    expect(lines.filter(line => line.includes('unchanged')).every(line => !line.includes('48;5;22'))).toBe(true)
    expect(lines.length).toBeLessThan(30)
  })

  it('reports line-ending-only changes without inventing added or removed lines', () => {
    const text = render(tool({ name: 'edit', diffs: [{ path: 'a.ts', oldText: 'one', newText: 'one\n' }] })).join('\n')
    expect(text).toContain('(+0 -0) · line endings changed')
  })

  it('marks bounded whole-file estimates rather than claiming exact minimal change counts', () => {
    const before = Array.from({ length: 500 }, (_, index) => 'before_' + index).join('\n')
    const after = Array.from({ length: 500 }, (_, index) => 'after_' + index).join('\n')
    expect(render(tool({ name: 'edit', diffs: [{ path: 'a.ts', oldText: before, newText: after }] })).join('\n'))
      .toContain('(~+500 ~-500)')
  })
})
