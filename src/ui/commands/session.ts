/**
 * Session-facing commands whose handlers only need the shared context:
 * `/status`, `/cancel`, `/help`.
 *
 * @module dsh-native-tui/ui/commands/session
 */

import { formatLocalTimestamp } from '../format-time.js'
import type { CommandContext } from './context.js'
import type { AgentPresetsService } from './services.js'
import { NL } from './shared.js'
import { readSkillRows } from './skills.js'

/**
 * User-invocable skills for the `/help` footer.
 *
 * Reads through the same catalog `/skill` lists, so the two surfaces cannot
 * disagree about which skills exist; only the invocation filter differs, since a
 * footer naming every model-only skill would bury the commands it is there to
 * summarize.
 * @param ctx - command context.
 * @returns user-invocable skills, empty when discovery failed.
 */
export async function loadSkills(ctx: CommandContext): Promise<readonly { readonly name: string; readonly description: string; readonly modelInvocable: boolean }[]> {
  const listed = await readSkillRows(ctx)
  if ('error' in listed) return []
  return listed.rows
    .filter(row => row.userInvocable)
    .map(row => ({ name: row.name, description: row.description, modelInvocable: row.modelInvocable }))
}

/** The `/status` notice. */
export function statusCommand(ctx: CommandContext): void {
  const headerInfo = ctx.active.agent.session.header
  const options = ctx.active.agent.options
  const current = ctx.modelSelection.current
  ctx.notice('info', [
    'Session: ' + ctx.active.id,
    'Directory: ' + (headerInfo.cwd ?? ctx.config.cwd),
    'Model: ' + (current?.provider ?? options.provider ?? 'deepseek-official') + '/' + (current?.model ?? options.model ?? 'deepseek-flash'),
    'Reasoning: ' + (current?.reasoningEffort ?? 'provider default'),
    'State: ' + ctx.active.agent.status,
    'Preset: ' + ((ctx.host.get('agentPresets') as AgentPresetsService | undefined)?.composedPreset(ctx.active.agent.ctx) ?? '(none)'),
    'Events: ' + String(ctx.active.agent.session.snapshotEvents().length),
    'Created: ' + formatLocalTimestamp(headerInfo.createdAt),
  ].join(NL))
}

/** The `/help` notice: local commands, host commands, and callable skills. */
export async function helpCommand(ctx: CommandContext, localLines: readonly string[]): Promise<void> {
  const hostCommands = ctx.host.commands.list(ctx.active.agent)
    .map(command => '/' + command.name + (command.input === undefined ? '' : ' ' + command.input.hint))
  const skills = await loadSkills(ctx)
  ctx.notice('info', [
    'Local commands:',
    ...localLines,
    'Host commands: ' + (hostCommands.length === 0 ? '(none)' : hostCommands.join(' · ')),
    'Skills: ' + (skills.length === 0 ? '(none)' : skills.map(skill => '/' + skill.name).join(' · ')),
    'Enter sends; when the agent runs, Enter steers and Esc cancels.',
  ].join(NL))
}
