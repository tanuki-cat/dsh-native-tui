import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { contextCommand, contextReport } from '../src/ui/commands/context-stats.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import type { ContextReportData } from '../src/ui/context-report.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'
import type { ContextBreakdown, SessionMetrics } from '../src/runtime/metrics.js'

const metrics = (): SessionMetrics => ({ turns: 3, steps: 5, totalTokens: 71000,
  contextPercent: 25, contextEstimateTokens: 261613, contextWindowTokens: 1000000, contextCompactPercent: 80 })
const breakdown = (): ContextBreakdown => ({ systemTokens: 50331, toolsTokens: 628, messageTokens: 210654, rebuilt: 'out-of-scale' })

function harness(theme: 'dark' | 'light' | 'plain' = 'dark', figures = { metrics: metrics(), breakdown: breakdown() as ContextBreakdown | undefined }) {
  const palette = createPalette(theme)
  const notices: TranscriptBlock[] = []
  const ctx = { palette, readContext: () => figures,
    notice: (tone: 'info', text: string, contextReport?: ContextReportData) => {
      notices.push({ kind: 'notice', tone, text, seq: 1, ...(contextReport === undefined ? {} : { contextReport }) })
    },
  } as unknown as CommandContext
  const renderer = new TranscriptRenderer({ palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 })
  const render = (width = 100): string[] => { renderer.set([], notices); return renderer.container.render(width) }
  contextCommand(ctx)
  return { palette, notices, renderer, render, figures }
}

describe('context command final rendering', () => {
  it.each(['dark', 'light', 'plain'] as const)('retains bucket colors and occupancy through the %s notice pipeline', theme => {
    const h = harness(theme), rows = h.render()
    const bar = rows.find(row => stripTerminalSequences(row).trim().startsWith('█'))!
    expect(bar).toContain(h.palette.contextBucket('system')('██'))
    expect(bar).toContain(h.palette.contextBucket('tools')('█'))
    expect(bar).toContain(h.palette.contextBucket('messages')('███████'))
    for (const [bucket, label] of [['system', 'system prompt'], ['tools', 'tool definitions'], ['messages', 'messages']] as const) {
      const row = rows.find(row => row.includes(label))!
      expect(row).toContain(h.palette.contextBucket(bucket)('█'))
    }
    const plain = rows.map(stripTerminalSequences).join('\n')
    expect(plain).toContain('Context used: 25%  ·  ~262K / 1M')
    expect(plain).toContain('19.2%')
    expect(plain).toContain('0.3%')
    expect(plain).toContain('80.5%')
    const cells = stripTerminalSequences(bar).trim()
    expect(cells).toHaveLength(40)
    expect([...cells].filter(cell => cell === '█')).toHaveLength(10)
    expect(rows.every(row => visibleWidth(row) <= 100)).toBe(true)
    expect(h.notices[0]?.kind === 'notice' ? h.notices[0].text : '').not.toContain('\x1b')
    if (theme === 'plain') expect(rows.join('\n')).not.toContain('\x1b')
  })

  it.each([1, 12, 40, 50, 80])('keeps all themed rows within %i columns', width => {
    for (const theme of ['dark', 'light', 'plain'] as const) expect(harness(theme).render(width).every(row => visibleWidth(row) <= width)).toBe(true)
  })

  it('keeps the command-time metrics and composition when their source objects change', () => {
    const h = harness()
    Object.assign(h.figures.metrics, { contextPercent: 99, contextEstimateTokens: 990000 })
    Object.assign(h.figures.breakdown!, { systemTokens: 0, toolsTokens: 0, messageTokens: 990000 })
    const rendered = h.render().map(stripTerminalSequences).join('\n')
    expect(rendered).toContain('Context used: 25%')
    expect(rendered).toContain('19.2%')
    expect(rendered).not.toContain('99%')
  })

  it('recolors the retained report on a palette refresh', () => {
    const h = harness()
    expect(h.render().join('\n')).toContain('\x1b[38;5;141m█')
    Object.assign(h.palette, createPalette('light'))
    h.renderer.refreshPalette()
    const changed = h.render().join('\n')
    expect(changed).toContain('\x1b[38;5;98m█')
    expect(changed).not.toContain('\x1b[38;5;141m')
  })

  it('does not treat ordinary report-looking text as trusted styling', () => {
    const h = harness()
    h.notices.splice(0, 1, { kind: 'notice', tone: 'info', text: '\x1b]52;c;CLIPBOARD\x07' + contextReport(metrics(), breakdown(), h.palette) + '\x9b31m\x1b[2J' })
    const rendered = h.render().join('\n')
    for (const code of ['\x1b]52;', '\x1b[2J', '\x9b', '\x1b[38;5;141m', '\x1b[38;5;39m']) expect(rendered).not.toContain(code)
    expect(stripTerminalSequences(rendered)).toContain('Context used: 25%')
  })

  it('builds rich report styling from data rather than the notice text', () => {
    const h = harness(), block = h.notices[0]!
    h.notices[0] = { ...block, text: '\x1b]52;c;CLIPBOARD\x07FORGED_REPORT' } as TranscriptBlock
    const rendered = h.render().join('\n')
    expect(rendered).toContain(h.palette.contextBucket('tools')('█'))
    expect(rendered).not.toContain('FORGED_REPORT')
    expect(rendered).not.toContain('\x1b]52;')
  })

  it.each(['unmounted', 'empty', 'waiting'] as const)('preserves the %s report state', state => {
    const value = metrics()
    if (state === 'waiting') Object.assign(value, { contextPercent: undefined, contextEstimateTokens: undefined, contextWindowTokens: undefined })
    const composition = state === 'unmounted' ? undefined : state === 'empty' ? { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } : breakdown()
    const h = harness('dark', { metrics: value, breakdown: composition })
    const rendered = h.render().map(stripTerminalSequences).join('\n')
    expect(rendered).toContain(state === 'unmounted' ? 'Composition: unknown' : state === 'empty' ? 'surface is still empty' : 'Waiting for the first provider usage sample')
    if (state === 'waiting') expect(rendered).not.toContain('Context used: 0%')
  })
})
