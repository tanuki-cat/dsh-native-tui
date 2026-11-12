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
import { isInteractionMode } from '../../interaction-modes.js'
import type { InteractionModeService as ModeService } from '../../interaction-modes.js'
import { modeCommand } from './mode.js'
import { changePermissions } from './permission-change.js'

/** The `/permissions` command. */
export async function permissionsCommand(ctx: CommandContext, args: string): Promise<void> {
  if (ctx.signal.aborted) return
  if (ctx.active.agent.status === 'running') {
    ctx.notice('warning', 'Wait for the running turn to finish or cancel it before changing permissions.')
    return
  }
  args = args.trim()
  const modes = ctx.host.get('interactionModes') as ModeService | undefined
  if (modes !== undefined) {
    if (isInteractionMode(args)) { await modeCommand(ctx, args); return }
    if (modes.current(ctx.active.agent) === 'plan') {
      ctx.notice('warning', 'Leave plan mode through /mode before selecting an advanced permission preset.')
      return
    }
  }
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
    try {
      if (!await changePermissions(ctx, agent => {
        const previous = presets.current(agent.session)
        try { presets.set(agent.session, args) }
        catch (error) {
          if (args !== previous) presets.set(agent.session, previous)
          throw error
        }
      })) return
      ctx.notice('info', 'Permission preset: ' + args)
      ctx.renderStatus()
    }
    catch (error) { ctx.notice('error', 'Could not change permissions: ' + errorMessage(error)) }
    return
  }
  const names = presets.names.filter(name => !isInteractionMode(name))
  if (names.length === 0) {
    ctx.notice('warning', 'No native permission presets are available in this profile.')
    return
  }
  const currentPreset = presets.current(ctx.active.agent.session)
  const presetChoice = await showChoice(
    ctx.tui,
    ctx.palette,
    'Permission preset (current: ' + currentPreset + ')',
    names.map(name => {
      const spec = presets.resolve(name)
      return {
        value: name,
        label: (name === currentPreset ? '* ' : '  ') + name,
        description: spec.sandbox + ' · approval: ' + spec.approval,
      }
    }),
    'Enter selects · Esc cancels',
    ctx.signal,
  )
  if (presetChoice !== undefined) await permissionsCommand(ctx, presetChoice)
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
    if (typeof subagents.listDescendants === 'function') {
      const rows = await subagents.listDescendants(ctx.active.id)
      if (rows.length === 0) {
        ctx.notice('info', 'No subagents for this session.')
        return
      }
      ctx.notice('info', 'Subagents:' + NL + rows.map(row => {
        const indent = '  '.repeat(Math.max(0, row.depth - 1))
        if (row.kind === 'diagnostic') return indent + '[unavailable] ' + row.id + '  (' + (row.reason ?? 'unknown') + ')'
        const name = row.path ?? row.name ?? row.id
        return indent + name + '  ' + (row.mode ?? 'unknown')
          + (row.label === undefined ? '' : '  ' + row.label)
          + '  ' + (row.activity === 'running' ? 'running' : 'inactive')
          + (row.hasChildren === true ? '  (has children)' : '')
      }).join(NL))
      return
    }
    if (typeof subagents.listChildren !== 'function') {
      ctx.notice('warning', 'This Host exposes no subagent listing.')
      return
    }
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
