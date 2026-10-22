/**
 * Session-facing commands whose handlers only need the shared context:
 * `/status`, `/cancel`, `/help`.
 *
 * @module dsh-native-tui/ui/commands/session
 */

import { formatLocalTimestamp } from '../format-time.js'
import type { CommandContext } from './context.js'
import type { AgentPresetsService, SkillsCatalog } from './services.js'
import { NL } from './shared.js'

/** User-invocable skills for the `/help` footer. */
export async function loadSkills(ctx: CommandContext): Promise<readonly { readonly name: string; readonly description: string; readonly modelInvocable: boolean }[]> {
  let registry: SkillsCatalog | undefined
  try {
    registry = (ctx.active.agent.ctx.get('skills') as SkillsCatalog | undefined)
      ?? (ctx.host.get('skills') as SkillsCatalog | undefined)
  }
  catch {
    registry = ctx.host.get('skills') as SkillsCatalog | undefined
  }
  if (registry === undefined) return []
  try {
    const list = await registry.list({ cwd: ctx.config.cwd, scope: ctx.active.agent })
    return list
      .filter(skill => skill.invocation === undefined || skill.invocation.userInvocable !== false)
      .map(skill => ({
        name: skill.name,
        description: skill.description,
        modelInvocable: skill.invocation === undefined || skill.invocation.modelInvocable !== false,
      }))
  }
  catch {
    return []
  }
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
