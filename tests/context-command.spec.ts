import { describe, expect, it } from 'vitest'
import { contextReport } from '../src/ui/commands/context-stats.js'
import type { ContextBreakdown, SessionMetrics } from '../src/runtime/metrics.js'
import { createPalette } from '../src/ui/theme.js'

/** Occupancy as the status row folds it for a session that has reported usage. */
function metricsOf(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    turns: 3,
    steps: 5,
    totalTokens: 71_000,
    contextPercent: 25,
    contextEstimateTokens: 261_613,
    contextWindowTokens: 1_000_000,
    contextCompactPercent: 80,
    ...overrides,
  }
}

/** A composition already rebased onto the occupancy, as the reader now returns it. */
const breakdown: ContextBreakdown = {
  systemTokens: 50_331,
  toolsTokens: 628,
  messageTokens: 210_654,
  rebuilt: 'out-of-scale',
}

/** The meter's raw, un-rebased figures, which can exceed the occupancy. */
const rawBreakdown: ContextBreakdown = { systemTokens: 50_331, toolsTokens: 628, messageTokens: 373_473 }

describe('context report', () => {
  it('prints the occupancy first, then the composition legend', () => {
    const lines = contextReport(metricsOf(), breakdown).split('\n')
    expect(lines[0]).toBe('Context used: 25%  ·  ~262K / 1M')
    expect(lines[1]).toBe('Automatic compaction: at 80% of the window')
    // Blank spacer, then the bar, whose fill length is the headline percentage.
    expect(lines[2]).toBe('')
    const bar = lines[3] ?? ''
    expect([...bar].filter(cell => cell !== '░')).toHaveLength(10)
    expect([...bar]).toHaveLength(40)
    expect(lines[4]).toContain('system prompt')
    // Rebasing makes the split total exactly the occupancy, so the shares are
    // 50.3K / 628 / 210.7K of 261.6K: 19.2% / 0.3% / 80.5%.
    expect(lines[4]).toContain('19.2%')
    expect(lines[5]).toContain('tool definitions')
    expect(lines[5]).toContain('0.3%')
    expect(lines[6]).toContain('messages')
    expect(lines[6]).toContain('80.5%')
  })

  it('never paints more of the bar than the stated occupancy', () => {
    // The defect this pins: a fully filled bar beside "Context used: 25%" reads
    // as 100% occupancy, and that is what the panel shipped with.
    const bar = contextReport(metricsOf({ contextPercent: 25 }), breakdown).split('\n')[3] ?? ''
    expect(bar.endsWith('░'.repeat(30))).toBe(true)
    const occupancy = contextReport(metricsOf({ contextPercent: 60 }), breakdown).split('\n')[3] ?? ''
    expect([...occupancy].filter(cell => cell !== '░')).toHaveLength(24)
  })

  it('keeps every bucket inside the occupancy it belongs to', () => {
    // The defect this pins: on a real session one bucket (messages) read larger
    // than the whole context, because the meter prices reasoning the request
    // never replays. Rebasing makes the parts sum to the whole.
    const text = contextReport(metricsOf(), breakdown)
    expect(text).not.toContain('~373K')
    expect(text).not.toContain('~305K')
    const rows = text.split('\n').slice(4, 7)
    expect(rows.every(row => row.includes('~'))).toBe(true)
    // The split's total is the occupancy, so both state the same number.
    expect(text).toContain('~262K')
  })

  it('says the split was rescaled rather than claiming two totals', () => {
    const text = contextReport(metricsOf(), breakdown)
    expect(text).toContain('Reasoning the request does not replay is left out')
    expect(text).toContain('scaled to the provider')
  })

  it('leaves a raw composition unexplained rather than inventing a caveat', () => {
    // Without the rebuild marker the figures are the meter's own; the report
    // must not claim a rescale that did not happen.
    const text = contextReport(metricsOf(), rawBreakdown)
    expect(text).not.toContain('Reasoning the request does not replay')
  })

  it('states shares with a decimal so a sub-1% bucket does not read as zero', () => {
    const text = contextReport(metricsOf(), breakdown)
    expect(text).toContain('0.3%')
    expect(text).not.toContain(' 0%')
  })

  it('aligns the legend columns so the rows read as a table', () => {
    const legend = contextReport(metricsOf(), breakdown).split('\n').slice(4, 7)
    expect(new Set(legend.map(row => row.length))).toHaveProperty('size', 1)
    // The share column starts at the same offset on every row, glyph included.
    expect(legend.map(row => row.charAt(1))).toEqual([' ', ' ', ' '])
    expect(legend.map(row => row.slice(19, 26))).toEqual(['  19.2%', '   0.3%', '  80.5%'])
    // The trailing amounts share one right edge too.
    // The amounts are the rebased buckets, so messages now sits at ~211K.
    expect(legend.map(row => row.slice(26))).toEqual(['    ~50.3K', '      ~628', '     ~211K'])
  })

  it('reports an occupancy without a composition as unknown, not zero', () => {
    const text = contextReport(metricsOf(), undefined)
    expect(text).toContain('Context used: 25%')
    expect(text).toContain('Composition: unknown (the token meter is not mounted).')
    expect(text).not.toContain('system prompt')
    expect(text).not.toContain('tool definitions')
  })

  it('distinguishes an empty surface from an unmounted meter', () => {
    const text = contextReport(metricsOf(), { systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
    expect(text).toContain('Composition: the surface is still empty.')
    expect(text).not.toContain('unknown')
  })

  it('waits for a sample before pricing anything', () => {
    // A session that has not settled a response yet has no percentage; printing
    // 0% would claim the context is empty.
    const text = contextReport(metricsOf({
      contextPercent: undefined,
      contextEstimateTokens: undefined,
      contextWindowTokens: undefined,
      contextCompactPercent: undefined,
    }), breakdown)
    expect(text.split('\n')[0]).toBe('Context used: —')
    expect(text).toContain('Waiting for the first provider usage sample')
    expect(text).not.toContain('Context used: 0%')
    // The composition is still knowable, so it is still printed, on an empty track.
    expect(text).toContain('system prompt')
    expect(text).toContain('░'.repeat(40))
  })

  it('omits the trigger line when the compactor has no threshold', () => {
    const text = contextReport(metricsOf({ contextCompactPercent: undefined }), undefined)
    expect(text).not.toContain('Automatic compaction')
    expect(text.split('\n')[0]).toBe('Context used: 25%  ·  ~262K / 1M')
  })

  it('drops the figures when the window is unknown', () => {
    // A window the meter never recorded still yields an occupancy percentage
    // from the catalog value, but there is no denominator to show beside it.
    const text = contextReport(metricsOf({ contextWindowTokens: undefined, contextEstimateTokens: undefined }), breakdown)
    expect(text.split('\n')[0]).toBe('Context used: 25%')
  })

  it('colors each bucket row and its bar segment the same way', () => {
    const palette = createPalette('dark')
    const text = contextReport(metricsOf(), breakdown, palette)
    // Read the palette's own hues rather than parsing escape sequences back out
    // of the report: a row must carry the colour its bucket owns.
    // Legend rows are the only ones with a share and an amount: the bar has no
    // numbers, and the headline/trigger lines have no swatch glyph.
    const rows = text.split('\n').filter(line => line.includes('~') && line.includes('%') && line.includes('█'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain(palette.contextBucket('system')('█'))
    expect(rows[1]).toContain(palette.contextBucket('tools')('█'))
    expect(rows[2]).toContain(palette.contextBucket('messages')('█'))
    // The bar repeats the hues of the buckets that earned a cell. The tool
    // schema is 0.3% of the surface, under one of forty cells, so it has no
    // segment at all — its share survives in the legend only.
    const bar = text.split('\n').find(line => /[█░]{8,}/.test(line)) ?? ''
    // The system run is two cells, so its tinted text is two glyphs long.
    expect(bar).toContain(palette.contextBucket('system')('█'.repeat(2)))
    expect(bar).toContain(palette.contextBucket('messages')('█'.repeat(8)))
    expect(bar).not.toContain(palette.contextBucket('tools')('█'))
  })

  it('stays plain when no palette is supplied', () => {
    // The notice surface is plain text by default, so the report must not leak
    // escape sequences when a caller omits colours.
    expect(contextReport(metricsOf(), breakdown)).not.toContain('\u001B')
  })

  it('keeps every line free of tabs so the notice renders intact', () => {
    expect(contextReport(metricsOf(), breakdown)).not.toContain('\t')
  })
})
