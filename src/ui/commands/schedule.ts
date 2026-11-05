/** Host-wide task management over the rc.1 Schedule API. */
import { ScheduleId, type ScheduleCatalogEntry, type ScheduleService } from '@deepseek-ai/dsh-schedule'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { showChoice, showMultilineInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { parseScheduleCreate, parseSchedulePatch } from './schedule-input.js'
import { errorMessage, NL } from './shared.js'

const USAGE = 'Usage: /schedule [list [offset] [all|active|inactive] | add <seconds> <title> | create [JSON] | view|edit|pause|resume|run|delete|history <id>]'
const current = (ctx: CommandContext): boolean => !ctx.signal.aborted && ctx.isCurrent?.() !== false
function rowText(row: ScheduleCatalogEntry): string {
  const destination = row.target.kind === 'new' ? 'new session each time' : row.target.sessionId
  return row.id + '  ' + row.status + '  ' + row.kind + '  ' + row.title + '  ' + row.scheduledAt + ' → ' + destination
}
async function confirm(ctx: CommandContext, action: string, row: ScheduleCatalogEntry): Promise<boolean> {
  return await showChoice(ctx.tui, ctx.palette, action + ' Host task “' + row.title + '”?', [
    { value: 'no', label: 'Cancel' }, { value: 'yes', label: action, description: rowText(row) },
  ], 'Host-wide operation · Enter selects · Esc cancels', ctx.signal) === 'yes' && current(ctx)
}
/** Manage all Host tasks; new tasks explicitly target the current Session unless changed by the user. */
export async function scheduleCommand(ctx: CommandContext, args: string): Promise<void> {
  const service = ctx.host.get('schedule') as ScheduleService | undefined
  if (service === undefined) { ctx.notice('warning', 'The schedule service is unavailable.'); return }
  const [command = '', ...tokens] = args.trim().split(/\s+/u)
  const rest = args.trim().slice(command.length).trim()
  try {
    if (!current(ctx)) return
    if (command === '' || command === 'list') {
      const hasOffset = tokens[0] !== undefined && /^\d+$/u.test(tokens[0])
      const offset = hasOffset ? Number(tokens[0]) : 0
      const filter = tokens[hasOffset ? 1 : 0] ?? 'all'
      if (!Number.isSafeInteger(offset) || offset < 0 || !['all', 'active', 'inactive'].includes(filter) || tokens.length > (hasOffset ? 2 : 1)) { ctx.notice('warning', USAGE); return }
      const page = await service.list({ limit: 20, offset, ...filter === 'all' ? {} : { active: filter === 'active' } })
      ctx.notice('info', 'Host tasks: ' + page.shown + ' shown / ' + page.total + ' total (offset ' + page.offset + ')' + NL
        + (page.items.length === 0 ? 'No matching tasks.' : page.items.map(rowText).join(NL))
        + (page.offset + page.shown < page.total ? NL + 'Next: /schedule list ' + (page.offset + page.shown) + ' ' + filter : ''))
      return
    }
    if (command === 'add') {
      const match = /^(\d+)\s+(.+)$/u.exec(rest)
      const seconds = Number(match?.[1])
      if (match === null || !Number.isSafeInteger(seconds) || seconds < 1) { ctx.notice('warning', 'Usage: /schedule add <seconds> <title>'); return }
      const title = match[2]!.trim()
      const row = await service.create({ title, prompt: title, timing: { kind: 'after', after_seconds: seconds }, target: { kind: 'session', sessionId: ctx.active.id } }, ctx.active.id, ctx.signal)
      ctx.notice('info', 'Task created: ' + rowText(row)); return
    }
    if (command === 'create') {
      const json = rest || await showMultilineInput(ctx.tui, ctx.palette, 'Create Host task (JSON)', JSON.stringify({ title: '', prompt: '', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: ctx.active.id } }, null, 2), 'Ctrl+Enter submits · Esc cancels · explicit time zones required', ctx.signal)
      if (json === undefined || !current(ctx)) return
      const row = await service.create(parseScheduleCreate(json, ctx.active.id), ctx.active.id, ctx.signal)
      ctx.notice('info', 'Task created: ' + rowText(row)); return
    }
    if (!['view', 'edit', 'pause', 'resume', 'run', 'delete', 'history'].includes(command) || rest === '') {
      ctx.notice('warning', rest === '' && command === 'delete' ? 'Usage: /schedule delete <id>' : USAGE); return
    }
    if ((command !== 'edit' && command !== 'history' && tokens.length !== 1) || (command === 'history' && tokens.length > 2)) { ctx.notice('warning', USAGE); return }
    const id = ScheduleId(tokens[0]!)
    if (command === 'history') {
      const result = await service.history({ id, limit: 20, ...tokens[1] === undefined ? {} : { before: MessageId(tokens[1]) } })
      ctx.notice('info', 'Host task delivery history:' + NL + JSON.stringify(result, null, 2)); return
    }
    const row = await service.view({ id })
    if ('code' in row) { ctx.notice('warning', row.code + ': ' + id); return }
    if (command === 'view') { ctx.notice('info', 'Host task:' + NL + JSON.stringify(row, null, 2)); return }
    if (command === 'run') {
      if (!await confirm(ctx, 'Run now', row)) return
      const result = await service.run({ id }, ctx.signal)
      ctx.notice('code' in result ? 'warning' : 'info', 'Manual delivery: ' + JSON.stringify(result)); return
    }
    const expectedUpdatedAt = row.updatedAt ?? null
    if (command === 'delete') {
      if (!await confirm(ctx, 'Delete', row)) return
      const result = await service.edit({ id, action: 'delete', expectedUpdatedAt }, ctx.active.id, ctx.signal)
      ctx.notice('code' in result ? 'warning' : 'info', 'Task delete: ' + JSON.stringify(result)); return
    }
    let patch
    if (command === 'pause' || command === 'resume') patch = { active: command === 'resume' }
    else {
      const inline = rest.slice(id.length).trim()
      const json = inline || await showMultilineInput(ctx.tui, ctx.palette, 'Edit Host task fields (JSON)', JSON.stringify({ title: row.title, prompt: row.prompt }, null, 2), 'Ctrl+Enter submits · Esc cancels · explicit time zones required', ctx.signal)
      if (json === undefined || !current(ctx)) return
      patch = parseSchedulePatch(json)
    }
    if (!current(ctx)) return
    const result = await service.edit({ id, action: 'update', patch, expectedUpdatedAt }, ctx.active.id, ctx.signal)
    ctx.notice('code' in result ? 'warning' : 'info', 'Task edit: ' + JSON.stringify(result)
      + ('code' in result && result.code === 'schedule_conflict' ? NL + 'Task changed. Run /schedule view ' + id + ' and review before editing again.' : ''))
  } catch (error) { if (current(ctx)) ctx.notice('error', 'Schedule failed: ' + errorMessage(error)) }
}
