/**
 * `/tools`, `/tool`, and `/diff`.
 *
 * @module dsh-native-tui/ui/commands/tools
 */

import { collectToolCalls } from '../../runtime/tool-log.js'
import { diffLines } from '../diff.js'
import { showTextPager } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { NL } from './shared.js'

/** The `/tools` command. */
export function toolsCommand(ctx: CommandContext): void {
  const calls = collectToolCalls(ctx.active.agent.session.snapshotEvents(), 20)
  if (calls.length === 0) {
    ctx.notice('info', 'No tool calls recorded in this session yet.')
    return
  }
  ctx.notice('info', 'Tool calls:' + NL + calls.map((call, index) => String(index) + '. ' + call.name
    + (call.isError === true ? '  error' : call.result === undefined ? '  pending' : '  ok')).join(NL)
    + NL + 'Use /tool <index> to page the full arguments and result.')
}

/** The `/tool` command: page one call's arguments and result. */
export async function toolCommand(ctx: CommandContext, args: string): Promise<void> {
  if (args === '') {
    ctx.notice('warning', 'Usage: /tool <index> (see /tools)')
    return
  }
  const index = Number(args)
  if (!Number.isSafeInteger(index) || index < 0) {
    ctx.notice('warning', 'Usage: /tool <index> (see /tools)')
    return
  }
  const call = collectToolCalls(ctx.active.agent.session.snapshotEvents(), 20)[index]
  if (call === undefined) {
    ctx.notice('warning', 'No tool call at index ' + String(index) + '.')
    return
  }
  let formattedArgs = call.args
  try {
    formattedArgs = JSON.stringify(JSON.parse(call.args), null, 2)
  }
  catch {
    // Keep the recorded text when arguments are not JSON.
  }
  const text = call.name + ' · ' + call.callId + ' · ' + (call.isError === true ? 'error' : 'ok')
    + NL + NL + 'Arguments:' + NL + formattedArgs
    + NL + NL + 'Result:' + NL + (call.result === undefined ? '(pending)' : call.result)
  await showTextPager(ctx.tui, ctx.palette, 'Tool · ' + call.name, text, ctx.signal)
}

/** The `/diff` command: page the latest or one indexed tool diff. */
export async function diffCommand(ctx: CommandContext, args: string): Promise<void> {
  const calls = collectToolCalls(ctx.active.agent.session.snapshotEvents(), 50)
  const withDiffs = calls
    .map((call, index) => ({ call, index }))
    .filter(item => item.call.diffs !== undefined && item.call.diffs.length > 0)
  if (withDiffs.length === 0) {
    ctx.notice('info', 'No file diffs recorded in this session yet.')
    return
  }
  let entry = withDiffs.at(-1)
  if (args !== '') {
    const index = Number(args)
    if (!Number.isSafeInteger(index) || index < 0) {
      ctx.notice('warning', 'Usage: /diff [tool-index]')
      return
    }
    entry = withDiffs.find(item => item.index === index)
    if (entry === undefined) {
      ctx.notice('warning', 'No tool diff at index ' + String(index) + '. Use /tools to list calls.')
      return
    }
  }
  if (entry === undefined)
    return
  const lines = [ctx.palette.bold('Diff · ' + entry.call.name + ' · ' + entry.call.callId)]
  for (const diff of entry.call.diffs ?? []) {
    lines.push(ctx.palette.bold(ctx.palette.accent('diff ' + diff.path)))
    for (const row of diffLines(diff.oldText, diff.newText, 120)) {
      lines.push(row.kind === 'add'
        ? ctx.palette.success('+ ' + row.text)
        : row.kind === 'remove' ? ctx.palette.error('- ' + row.text) : ctx.palette.dim('  ' + row.text))
    }
  }
  await showTextPager(ctx.tui, ctx.palette, 'Diff · ' + entry.call.name, lines.join('\n'), ctx.signal)
}
