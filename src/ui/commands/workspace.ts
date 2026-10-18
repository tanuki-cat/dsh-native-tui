/**
 * `/workspaces` and `/schedule`.
 *
 * @module dsh-native-tui/ui/commands/workspace
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHostSession, type HostSession } from '../../runtime/agent.js'
import type { CommandContext } from './context.js'
import type { ScheduleService, WorkspaceService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** Start a session in another directory, keeping the current preset. */
export type SwitchToSession = (next: () => Promise<HostSession>) => Promise<void>

/** The agent preset new sessions should use. */
export type PresetForNewSession = () => string | undefined

/**
 * The `/workspaces` command.
 * @param ctx - command context.
 * @param args - the text after the command name.
 * @param switchTo - the app's session switch, which disposes the old session.
 * @param selectedPreset - the preset a new session should inherit.
 */
export async function workspacesCommand(
  ctx: CommandContext,
  args: string,
  switchTo: SwitchToSession,
  selectedPreset: PresetForNewSession,
): Promise<void> {
  const workspaceService = ctx.host.get('workspaceRegistry') as unknown as WorkspaceService | undefined
  if (workspaceService === undefined) {
    ctx.notice('warning', 'The workspace registry is unavailable.')
    return
  }
  if (args === '') {
    const currentPath = ctx.active.agent.session.header.cwd ?? ctx.config.cwd
    const rows = workspaceService.list()
    if (rows.length === 0) {
      ctx.notice('info', 'No workspaces. Use /workspaces new <path>.')
      return
    }
    ctx.notice('info', 'Workspaces:' + NL + rows.map(row => {
      const marker = row.path === currentPath ? '*' : ' '
      return marker + ' ' + row.id + '  ' + row.title + '  ' + row.path + '  (' + String(row.sessionIds.length) + ' sessions)'
    }).join(NL) + NL + 'Use /workspaces use <id|path> to start a session there.')
    return
  }
  const parts = args.split(/\s+/u)
  const subcommand = parts[0] ?? ''
  const rest = args.slice(subcommand.length).trim()
  if (subcommand === 'new') {
    if (rest === '') {
      ctx.notice('warning', 'Usage: /workspaces new <path> [title]')
      return
    }
    const firstSpace = rest.indexOf(' ')
    const path = firstSpace === -1 ? rest : rest.slice(0, firstSpace)
    const title = firstSpace === -1 ? undefined : rest.slice(firstSpace + 1).trim()
    try {
      const created = await workspaceService.create(path, title === '' ? undefined : title)
      ctx.notice('info', 'Workspace created: ' + created.id + '  ' + created.path)
    } catch (error) {
      ctx.notice('error', 'Could not create workspace: ' + errorMessage(error))
    }
    return
  }
  if (subcommand === 'use') {
    if (rest === '') {
      ctx.notice('warning', 'Usage: /workspaces use <id|path>')
      return
    }
    try {
      const workspace = workspaceService.get(rest) ?? await workspaceService.resolveByPath(rest)
      if (workspace === undefined) {
        ctx.notice('warning', 'No workspace matches ' + rest)
        return
      }
      await switchTo(() => createHostSession(ctx.host, {
        ...ctx.config,
        sessionId: undefined,
        cwd: workspace.path,
        agentPreset: selectedPreset() ?? ctx.config.agentPreset,
      }))
    } catch (error) {
      ctx.notice('error', 'Could not switch workspace: ' + errorMessage(error))
    }
    return
  }
  if (subcommand === 'pin' || subcommand === 'unpin') {
    const id = rest === '' ? ctx.active.id : rest as SessionId
    try {
      if (subcommand === 'pin') await workspaceService.pinSession(id)
      else await workspaceService.unpinSession(id)
      ctx.notice('info', (subcommand === 'pin' ? 'Pinned ' : 'Unpinned ') + id)
    } catch (error) {
      ctx.notice('error', 'Could not ' + subcommand + ' session: ' + errorMessage(error))
    }
    return
  }
  if (subcommand === 'archive' || subcommand === 'unarchive') {
    if (rest === '') {
      ctx.notice('warning', 'Usage: /workspaces ' + subcommand + ' <session-id>')
      return
    }
    if (subcommand === 'archive' && rest === ctx.active.id) {
      ctx.notice('warning', 'Refusing to archive the active session; switch to another session first.')
      return
    }
    try {
      if (subcommand === 'archive') await workspaceService.archiveSession(rest as SessionId)
      else await workspaceService.unarchiveSession(rest as SessionId)
      ctx.notice('info', (subcommand === 'archive' ? 'Archived ' : 'Unarchived ') + rest)
    } catch (error) {
      ctx.notice('error', 'Could not ' + subcommand + ' session: ' + errorMessage(error))
    }
    return
  }
  ctx.notice('warning', 'Usage: /workspaces [new <path> [title] | use <id|path> | pin|unpin|archive|unarchive <id>]')
}

/** The `/schedule` command. */
export async function scheduleCommand(ctx: CommandContext, args: string): Promise<void> {
  const scheduleService = ctx.host.get('schedule') as unknown as ScheduleService | undefined
  if (scheduleService === undefined) {
    ctx.notice('warning', 'The schedule service is unavailable.')
    return
  }
  if (args === '') {
    try {
      const rows = await scheduleService.list({ sessionId: ctx.active.id })
      if (rows.length === 0) {
        ctx.notice('info', 'No active reminders for this session.')
        return
      }
      ctx.notice('info', 'Reminders:' + NL + rows.map(row => row.id + '  ' + row.kind + '  ' + row.title + '  ' + row.scheduledAt).join(NL))
    } catch (error) {
      ctx.notice('error', 'Could not list reminders: ' + errorMessage(error))
    }
    return
  }
  const parts = args.split(/\s+/u)
  const subcommand = parts[0] ?? ''
  const rest = args.slice(subcommand.length).trim()
  if (subcommand === 'add') {
    const firstSpace = rest.indexOf(' ')
    const secondsText = firstSpace === -1 ? rest : rest.slice(0, firstSpace)
    const title = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()
    const seconds = Number(secondsText)
    if (!Number.isSafeInteger(seconds) || seconds < 1 || title === '') {
      ctx.notice('warning', 'Usage: /schedule add <seconds> <title>')
      return
    }
    try {
      const created = await scheduleService.create(ctx.active.id, {
        title,
        prompt: title,
        after_seconds: seconds,
      })
      ctx.notice('info', 'Reminder created: ' + created.id + '  ' + created.scheduledAt)
    } catch (error) {
      ctx.notice('error', 'Could not create reminder: ' + errorMessage(error))
    }
    return
  }
  if (subcommand === 'delete') {
    if (rest === '') {
      ctx.notice('warning', 'Usage: /schedule delete <id>')
      return
    }
    try {
      const result = await scheduleService.delete({ sessionId: ctx.active.id, id: rest })
      ctx.notice('info', 'Reminder delete: ' + JSON.stringify(result))
    } catch (error) {
      ctx.notice('error', 'Could not delete reminder: ' + errorMessage(error))
    }
    return
  }
  ctx.notice('warning', 'Usage: /schedule [add <seconds> <title> | delete <id>]')
}
