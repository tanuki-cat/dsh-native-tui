import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { ToolCard } from '../src/ui/tool-card.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import type { TranscriptBlock, TranscriptEntry } from '../src/ui/transcript.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
const args = JSON.stringify({ command: 'printf STATUS_PROBE', code: 'return "STATUS_PROBE"' })
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 0 } as never,
})

describe.each(['dark', 'light', 'plain'] as const)('execution status headings in %s', theme => {
  it.each(['bash', 'pwsh', 'run_code'])('updates %s through partial output and every settled outcome', name => {
    const palette = createPalette(theme)
    const target = name === 'run_code' ? 'code' : (name === 'pwsh' ? 'PS> ' : '') + 'printf STATUS_PROBE'
    for (const runCodeDisplay of ['compact', 'detailed'] as const) for (const expanded of [false, true]) {
      const block: ToolBlock = { kind: 'tool', callId: 'status', name, args, pending: true }
      const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100, runCodeDisplay }
      const card = new ToolCard(block, options)
      card.setExpanded(expanded)
      const pending = card.render(100)
      expect(stripTerminalSequences(pending[0]!)).toContain('• Running ' + target)
      expect(pending[0]).toContain(palette.warning('• '))
      expect(pending.join('\n')).not.toContain('└ running…')
      card.update({ ...block, result: 'PARTIAL_OUTPUT' })
      expect(stripTerminalSequences(card.render(100)[0]!)).toContain('• Running ' + target)
      for (const outcome of [{}, { isError: true }, { stopped: true }]) {
        card.update({ ...block, pending: false, result: 'FINAL_OUTPUT', ...outcome })
        const rows = card.render(100)
        const text = stripTerminalSequences(rows.join('\n'))
        expect(text).toContain('• Ran ' + target)
        expect(text).toContain('FINAL_OUTPUT')
        expect(text).not.toMatch(/Running|running…/u)
        expect(card.isExpanded).toBe(expanded)
        if ('isError' in outcome) expect(text).toContain('└ error')
        if ('stopped' in outcome) expect(text).toContain('└ stopped')
        for (const width of [1, 12, 32]) expect(card.render(width).every(row => visibleWidth(row) <= width)).toBe(true)
        if (palette.plain) expect(rows.join('\n')).not.toContain('\x1b')
      }
    }
  })
})

describe('cached execution status updates', () => {
  it.each(['bash', 'pwsh', 'run_code'])('settles %s with an empty result on the retained card', name => {
    const palette = createPalette('plain')
    const renderer = new TranscriptRenderer({ palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 })
    const entries = [event('tool/call', { name, callId: 'status', arguments: args }, 1)]
    renderer.setEntries(entries)
    const card = renderer.container.children[0]
    expect(renderer.container.render(100)[0]).toContain('• Running ')
    entries.push(event('tool/result', { message: { source: { callId: 'status' }, content: [], isError: false } }, 2))
    renderer.setEntries(entries)
    expect(renderer.container.children[0]).toBe(card)
    expect(renderer.container.render(100)[0]).toContain('• Ran ')
    expect(renderer.container.render(100).join('\n')).not.toMatch(/Running|running…/u)
  })
})
