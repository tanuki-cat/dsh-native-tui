import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

type Tool = Extract<TranscriptBlock, { kind: 'tool' }>
const result = Array.from({ length: 30 }, (_, index) => 'OUTPUT_' + index).join('\n')
const source = Array.from({ length: 40 }, (_, index) => 'const value_' + index + ' = ' + index).join('\n')
const tool = (name: string, args: unknown, extra: Partial<Tool> = {}): Tool => ({
  kind: 'tool', callId: name, name, args: JSON.stringify(args), pending: false, result, ...extra,
})
const diff = { path: 'a.ts', oldText: 'before', newText: source }
const blocks: TranscriptBlock[] = [
  tool('read', { file_path: 'a.ts' }),
  tool('bash', { command: 'printf output' }),
  tool('pwsh', { command: 'Write-Output output' }),
  tool('write', { file_path: 'a.ts', content: source }, { operation: 'create', diffs: [{ ...diff, oldText: null }] }),
  tool('edit', { file_path: 'a.ts' }, { diffs: [diff] }),
  tool('apply_patch', {}, { diffs: [diff, { ...diff, path: 'b.ts' }] }),
  tool('mcp__test__lookup', { query: 'example' }),
  tool('run_code', { code: source }),
  { kind: 'context', label: 'policy', text: result },
]
const click = (y: number): TuiMouseEvent => ({ type: 'click', button: 'left', x: 3, y,
  screenX: 3, screenY: y, width: 100, height: 100, shift: false, alt: false, ctrl: false })

describe.each(['plain', 'dark', 'light'] as const)('unified %s details presentation', theme => {
  it.each(blocks)('uses one clickable footer for $kind $name', block => {
    const palette = createPalette(theme)
    const card = renderTranscriptBlock(block, { palette, markdown: markdownTheme(palette),
      showReasoning: true, maxEntries: 100, runCodeDisplay: 'compact' })
    const render = (width = 100) => card.render(width).map(stripTerminalSequences)
    const compact = render()
    expect(compact.at(-1)).toBe('  Show details · ctrl+o')
    expect(compact.filter(row => row.includes('ctrl+o'))).toHaveLength(1)
    expect(compact.join('\n')).not.toMatch(/to expand|to collapse|\+ Show details/u)
    expect(card.handleMouse?.(click(compact.length - 1))).toEqual({ handled: true })
    const expanded = render()
    expect(expanded.at(-1)).toBe('  Hide details · ctrl+o')
    expect(expanded.filter(row => row.includes('ctrl+o'))).toHaveLength(1)
    expect(expanded.length).toBeGreaterThan(compact.length)
    expect(card.handleMouse?.(click(1))).toBeUndefined()
    expect(render()).toEqual(expanded)
    for (const width of [1, 8, 24, 100]) {
      const rows = card.render(width)
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
      if (theme === 'plain') expect(rows.join('\n')).not.toContain('\x1b')
    }
    render()
    expect(card.handleMouse?.(click(expanded.length - 1))).toEqual({ handled: true })
    expect(render()).toEqual(compact)
  })
})

describe('details footer follows the card state', () => {
  const palette = createPalette('plain')
  const render = (block: TranscriptBlock) => renderTranscriptBlock(block, {
    palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100, runCodeDisplay: 'compact',
  })
  const rows = (block: TranscriptBlock): string[] => render(block).render(100).map(stripTerminalSequences)

  it('keeps a running card without preview content brief', () => {
    const running = rows(tool('grep', { pattern: 'example' }, { pending: true, result: undefined }))
    expect(running.join('\n')).not.toContain('Show details')
  })

  it('keeps one footer while a shell runs and after it settles', () => {
    const args = { command: 'printf output' }
    expect(rows(tool('bash', args, { pending: true, result: undefined })).at(-1)).toBe('  Show details · ctrl+o')
    expect(rows(tool('bash', args, { result: 'PASS' })).at(-1)).toBe('  Show details · ctrl+o')
  })

  it.each([{ label: 'failed', extra: { isError: true } }, { label: 'stopped', extra: { stopped: true } }])(
    'keeps one clickable footer on a $label card', ({ extra }) => {
      const card = render(tool('read', { file_path: 'a.ts' }, { result: 'ERROR_TEXT', ...extra }))
      const compact = card.render(100).map(stripTerminalSequences)
      expect(compact.join('\n')).toContain('ERROR_TEXT')
      expect(compact.filter(row => row.includes('ctrl+o'))).toHaveLength(1)
      expect(compact.at(-1)).toBe('  Show details · ctrl+o')
      expect(card.handleMouse?.(click(compact.length - 1))).toEqual({ handled: true })
      expect(card.render(100).map(stripTerminalSequences).at(-1)).toBe('  Hide details · ctrl+o')
    })
})
