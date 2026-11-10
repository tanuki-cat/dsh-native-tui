import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const tool = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool', callId: 'file', name: 'write', pending: false,
  args: '{"file_path":"src/MixedCase.ts","content":"after"}',
  ...overrides,
})
const diff = { path: 'src/MixedCase.ts', oldText: 'before', newText: 'after' }
function renderRows(block: ToolBlock, theme: 'plain' | 'dark' | 'light' = 'plain', expanded = false, width = 100): string[] {
  const palette = createPalette(theme)
  return renderTranscriptBlock(block, {
    palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100,
    toolsExpanded: expanded, runCodeDisplay: 'compact',
  }).render(width)
}
function render(block: ToolBlock, theme: 'plain' | 'dark' | 'light' = 'plain', expanded = false): string {
  return stripTerminalSequences(renderRows(block, theme, expanded).join('\n'))
}

describe('tool action labels', () => {
  it.each([
    { operation: 'update' as const, diffs: [diff] },
    { operation: 'update' as const, diffs: [{ ...diff, oldText: null }] },
    { operation: 'update' as const, diffs: undefined },
    { diffs: [diff] },
  ])('labels confirmed write updates as Edit: %s', fields => {
    const block = tool(fields)
    expect(render(block)).toContain('• Edit src/MixedCase.ts')
    expect(render(block)).not.toContain('• Write')
    expect(block.name).toBe('write')
  })

  it.each([
    { operation: 'create' as const, diffs: [{ ...diff, oldText: null }] },
    { pending: true },
    { isError: true, result: 'Permission denied' },
  ])('keeps creation and unconfirmed write labels as Write: %s', fields => {
    expect(render(tool(fields))).toContain('• Write src/MixedCase.ts')
  })

  it.each([true, false])('keeps explicit edit calls labeled Edit, including pure insertions (pending: %s)', pending => {
    const block = tool({ name: 'edit', pending, args: '{"file_path":"src/MixedCase.ts"}',
      ...(pending ? {} : { diffs: [{ ...diff, oldText: null }] }),
    })
    expect(render(block)).toContain('• Edit src/MixedCase.ts')
    expect(render(block)).not.toContain('• Write')
  })

  it.each(['plain', 'dark'] as const)('keeps Edit across expansion, errors and stops in %s', theme => {
    for (const expanded of [false, true]) for (const state of [{}, { isError: true }, { stopped: true }]) {
      expect(render(tool({ operation: 'update', diffs: [diff], ...state }), theme, expanded))
        .toContain('• Edit src/MixedCase.ts')
    }
  })

  it.each([
    ['read', 'Read'], ['grep', 'Search'], ['glob', 'Search'], ['find', 'Search'], ['skill', 'Skill'],
    ['todo_write', 'Todo write'], ['job_output', 'Job output'], ['web_search', 'Web search'],
  ])('capitalizes the %s action label', (name, label) => {
    expect(render(tool({ name }))).toContain('• ' + label + ' src/MixedCase.ts')
  })

  it('capitalizes MCP without changing server, method or path casing', () => {
    expect(render(tool({ name: 'mcp__IDEA__replaceTextInFile' })))
      .toContain('• MCP IDEA/replaceTextInFile src/MixedCase.ts')
  })

  it('capitalizes compact PTC action prefixes without changing recorded summaries', () => {
    const callLines = ['read src/MixedCase.ts', 'mcp IDEA.replaceTextInFile src/MixedCase.ts', 'skill MySkill']
    const block = tool({ name: 'run_code', args: '{"code":"return 1"}', callLines })
    const text = render(block)
    expect(text).toContain('• Ran code')
    expect(text).toContain('└ Read src/MixedCase.ts')
    expect(text).toContain('MCP IDEA.replaceTextInFile src/MixedCase.ts')
    expect(text).toContain('Skill MySkill')
    expect(block.callLines).toEqual(callLines)
  })
})

describe.each(['dark', 'light', 'plain'] as const)('tool keyword highlighting in %s', theme => {
  const palette = createPalette(theme)

  it('highlights native actions separately from paths and search expressions across expansion', () => {
    const cases: Array<readonly [ToolBlock, string, string]> = [
      [tool({ name: 'read' }), 'Read', 'src/MixedCase.ts'],
      [tool(), 'Write', 'src/MixedCase.ts'],
      [tool({ operation: 'update' }), 'Edit', 'src/MixedCase.ts'],
      [tool({ operation: 'update', diffs: [diff] }), 'Edit', 'src/MixedCase.ts'],
      [tool({ name: 'edit', diffs: [diff] }), 'Edit', 'src/MixedCase.ts'],
      ...['grep', 'glob', 'find'].map(name => [tool({ name, args: JSON.stringify({ path: 'src', pattern: 'MixedCase|TODO' }) }), 'Search', '"MixedCase|TODO" src'] as const),
      [tool({ name: 'mcp__IDEA__replaceTextInFile' }), 'MCP', 'IDEA/replaceTextInFile src/MixedCase.ts'],
    ]
    for (const expanded of [false, true]) for (const [block, action, target] of cases) {
      const heading = renderRows(block, theme, expanded)[0]!
      expect(heading).toContain(palette.accent(action) + ' ' + target)
      if (!palette.plain) expect(heading).not.toContain(palette.accent(target))
      else expect(heading).not.toContain('\x1b')
    }
  })

  it('highlights compact PTC actions without dimming or coloring their targets', () => {
    const callLines = ['read src/MixedCase.ts', 'grep MixedCase|TODO', 'glob *.ts', 'find src',
      'todo_write 2 tasks', 'web_search MixedCase Query', 'mcp IDEA.replaceTextInFile src/MixedCase.ts']
    const block = tool({ name: 'run_code', args: '{"code":"return 1"}', callLines })
    const text = renderRows(block, theme).join('\n')
    expect(text).toContain(palette.bold('Ran ') + palette.accent('code'))
    for (const [action, target] of [['Read', 'src/MixedCase.ts'], ['Search', 'MixedCase|TODO'],
      ['Search', '*.ts'], ['Search', 'src'], ['Todo write', '2 tasks'], ['Web search', 'MixedCase Query'],
      ['MCP', 'IDEA.replaceTextInFile src/MixedCase.ts']]) {
      expect(text).toContain(palette.accent(action!) + ' ' + target)
    }
    if (!palette.plain) expect(text).not.toContain('\x1b[2m' + palette.accent('Read'))
    else expect(text).not.toContain('\x1b')
    expect(block.callLines).toEqual(callLines)
    expect(block.name).toBe('run_code')
    expect(stripTerminalSequences(renderRows(block, theme, true).join('\n'))).toContain('• Ran code')
  })

  it('escapes untrusted control sequences before applying action styling', () => {
    const unsafe = '\x1b[31mINJECT\x9b31m\x1b]52;c;DATA\x07'
    const blocks = [tool({ name: unsafe }), tool({ name: 'read', args: JSON.stringify({ path: unsafe }) }),
      tool({ name: 'run_code', args: '{}', callLines: ['read ' + unsafe, unsafe + ' target'] })]
    for (const block of blocks) {
      const text = renderRows(block, theme, false, 160).join('\n')
      expect(text).not.toContain('\x1b[31mINJECT')
      expect(text).not.toContain('\x9b')
      expect(text).not.toContain('\x1b]52')
      expect(text).toContain('\\x1b[31mINJECT')
      expect(text).toContain('\\x9b31m')
    }
  })

  it('bounds styled native and compact rows on narrow terminals', () => {
    const blocks = [tool({ name: 'read' }), tool({ name: 'grep', args: '{"pattern":"你好MixedCase"}' }),
      tool({ name: 'run_code', args: '{}', callLines: ['read src/中文/MixedCase.ts', 'todo_write 你好👩‍💻'.repeat(4)] })]
    for (const width of [1, 12, 32, 80]) for (const block of blocks) {
      const rows = renderRows(block, theme, false, width)
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
      if (palette.plain) expect(rows.join('\n')).not.toContain('\x1b')
    }
  })
})
