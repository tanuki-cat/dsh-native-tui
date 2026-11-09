import { stripTerminalSequences } from '@earendil-works/pi-tui'
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
function render(block: ToolBlock, theme: 'plain' | 'dark' = 'plain', expanded = false): string {
  const palette = createPalette(theme)
  return stripTerminalSequences(renderTranscriptBlock(block, {
    palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100,
    toolsExpanded: expanded, runCodeDisplay: 'compact',
  }).render(100).join('\n'))
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
    ['read', 'Read'], ['grep', 'Grep'], ['glob', 'Glob'], ['find', 'Find'], ['skill', 'Skill'],
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
    expect(text).toContain('• Ran run_code')
    expect(text).toContain('└ Read src/MixedCase.ts')
    expect(text).toContain('MCP IDEA.replaceTextInFile src/MixedCase.ts')
    expect(text).toContain('Skill MySkill')
    expect(block.callLines).toEqual(callLines)
  })
})
