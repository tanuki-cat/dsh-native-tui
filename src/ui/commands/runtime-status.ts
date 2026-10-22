/**
 * `/permissions`, `/jobs`, and `/agents`.
 *
 * @module dsh-native-tui/ui/commands/runtime-status
 */

import { showChoice } from '../dialogs.js'
import { formatLocalTimestamp } from '../format-time.js'
import type { CommandContext } from './context.js'
import type { JobsService, PermissionPresets, SubagentsService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** The `/permissions` command. */
export async function permissionsCommand(ctx: CommandContext, args: string): Promise<void> {
  const presets = ctx.host.get('permissionPresets') as PermissionPresets | undefined
  if (presets === undefined) {
    ctx.notice('warning', 'The permission-preset service is unavailable.')
    return
  }
  if (args !== '') {
    if (!presets.names.includes(args)) {
      ctx.notice('warning', 'Unknown preset "' + args + '". Available: ' + presets.names.join(', '))
      return
    }
    presets.set(ctx.active.agent.session, args)
    ctx.notice('info', 'Permission preset: ' + args)
    ctx.renderStatus()
    return
  }
  const currentPreset = presets.current(ctx.active.agent.session)
  const presetChoice = await showChoice(
    ctx.tui,
    ctx.palette,
    'Permission preset (current: ' + currentPreset + ')',
    presets.names.map(name => ({
      value: name,
      label: (name === currentPreset ? '* ' : '  ') + name,
      description: name === 'workspace-write' ? 'Workspace writes only' : 'Full host access',
    })),
    'Enter selects · Esc cancels',
    ctx.signal,
  )
  if (presetChoice !== undefined) {
    presets.set(ctx.active.agent.session, presetChoice)
    ctx.notice('info', 'Permission preset: ' + presetChoice)
    ctx.renderStatus()
  }
}

/** The `/jobs` command. */
export function jobsCommand(ctx: CommandContext, args: string): void {
  const jobs = ctx.host.get('jobs') as JobsService | undefined
  if (jobs === undefined) {
    ctx.notice('warning', 'The background-jobs service is unavailable.')
    return
  }
  if (args.startsWith('kill ')) {
    const id = args.slice('kill '.length).trim()
    if (id === '') {
      ctx.notice('warning', 'Usage: /jobs kill <job-id>')
      return
    }
    try {
      const outcome = jobs.kill(id, ctx.active.id, 'user requested from native-tui')
      ctx.notice('info', 'Kill ' + id + ': ' + outcome)
    } catch (error) {
      ctx.notice('error', 'Kill failed: ' + errorMessage(error))
    }
    return
  }
  try {
    const rows = jobs.list(ctx.active.id)
    if (rows.length === 0) {
      ctx.notice('info', 'No background jobs for this session.')
      return
    }
    ctx.notice('info', 'Jobs:' + NL + rows.map(row => row.id + '  ' + row.status + '  ' + row.kind + '  ' + row.label
      + '  ' + formatLocalTimestamp(row.startedAt)
      + (row.progress === undefined ? '' : '  ' + row.progress)
      + (row.detail === undefined ? '' : '  ' + row.detail)).join(NL))
  } catch (error) {
    ctx.notice('error', 'Could not list jobs: ' + errorMessage(error))
  }
}

/** The `/agents` command. */
export async function agentsCommand(ctx: CommandContext): Promise<void> {
  const subagents = ctx.host.get('subagents') as SubagentsService | undefined
  if (subagents === undefined) {
    ctx.notice('warning', 'The subagent service is unavailable.')
    return
  }
  try {
    const rows = await subagents.listChildren(ctx.active.id)
    if (rows.length === 0) {
      ctx.notice('info', 'No subagents for this session.')
      return
    }
    ctx.notice('info', 'Subagents:' + NL + rows.map(row => row.id + '  ' + row.mode + '  ' + (row.label ?? '')
      + '  ' + formatLocalTimestamp(row.createdAt)).join(NL))
  } catch (error) {
    ctx.notice('error', 'Could not list subagents: ' + errorMessage(error))
  }
}
