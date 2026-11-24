import { describe, expect, it, vi } from 'vitest'
import { contextSummaryCommand } from '../src/ui/commands/context-summary.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { showTextPager } from '../src/ui/dialogs.js'

vi.mock('../src/ui/dialogs.js', () => ({ showTextPager: vi.fn() }))

function context(events: unknown[]) {
  return {
    tui: {},
    palette: {},
    signal: new AbortController().signal,
    notice: vi.fn(),
    active: { agent: { session: { snapshotEvents: () => events } } },
  } as unknown as CommandContext
}

const summary = (seq: number, text: string) => ({
  type: 'compaction/summary', seq, data: { summary: [{ type: 'text', text }] },
})

describe('/context summary', () => {
  it('pages the complete latest summary or the requested older event', async () => {
    const text = '压缩摘录'.repeat(1800) + '最后一行'
    const ctx = context([summary(2, 'previous'), summary(16, text), { type: 'compaction/end', seq: 17 }])
    await contextSummaryCommand(ctx, '')
    expect(showTextPager).toHaveBeenLastCalledWith(ctx.tui, ctx.palette, 'Compaction summary · 16', text, ctx.signal)
    await contextSummaryCommand(ctx, '2')
    expect(showTextPager).toHaveBeenLastCalledWith(ctx.tui, ctx.palette, 'Compaction summary · 2', 'previous', ctx.signal)
  })

  it('reports missing and malformed event numbers', async () => {
    const ctx = context([])
    await contextSummaryCommand(ctx, '2')
    expect(ctx.notice).toHaveBeenLastCalledWith('info', 'No compaction summary at event 2.')
    await contextSummaryCommand(ctx, '1.5')
    expect(ctx.notice).toHaveBeenLastCalledWith('warning', 'Usage: /context summary [event-seq]')
  })

  it('skips an empty trailing summary when no sequence is requested', async () => {
    const ctx = context([summary(4, 'Earlier summary'), summary(9, '   ')])
    await contextSummaryCommand(ctx, '')
    expect(showTextPager).toHaveBeenLastCalledWith(ctx.tui, ctx.palette, 'Compaction summary · 4', 'Earlier summary', ctx.signal)
    await contextSummaryCommand(ctx, '9')
    expect(ctx.notice).toHaveBeenLastCalledWith('info', 'No compaction summary at event 9.')
  })
})
