import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { showTextPager } from '../dialogs.js'
import { contentText } from '../transcript.js'
import type { CommandContext } from './context.js'

/** Show a persisted compaction summary independently of the retained transcript window. */
export async function contextSummaryCommand(ctx: CommandContext, args: string): Promise<void> {
  const seq = args === '' ? undefined : Number(args)
  if (seq !== undefined && (!/^\d+$/u.test(args) || !Number.isSafeInteger(seq))) {
    ctx.notice('warning', 'Usage: /context summary [event-seq]')
    return
  }
  const summaryOf = (candidate: { readonly data?: unknown }): string =>
    contentText((candidate.data as { readonly summary?: readonly ContentBlock[] } | undefined)?.summary)
  const events = ctx.active.agent.session.snapshotEvents()
  const event = seq === undefined
    ? events.findLast(candidate => (candidate.type as string) === 'compaction/summary' && summaryOf(candidate).trim() !== '')
    : events.findLast(candidate => (candidate.type as string) === 'compaction/summary' && Number(candidate.seq) === seq)
  const text = event === undefined ? '' : summaryOf(event)
  if (event === undefined || text.trim() === '') {
    ctx.notice('info', seq === undefined ? 'No compaction summary in this session.' : 'No compaction summary at event ' + String(seq) + '.')
    return
  }
  await showTextPager(ctx.tui, ctx.palette, 'Compaction summary · ' + String(event.seq), text, ctx.signal)
}
