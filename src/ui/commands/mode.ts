/** Current-session interaction mode picker and explicit Auto consent. */
import type { InteractionModeService as ModeService } from '../../interaction-modes.js'
import { isInteractionMode, MODE_DESCRIPTIONS, MODE_LABELS, type InteractionMode } from '../../interaction-modes.js'
import { showChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { errorMessage } from './shared.js'

export async function modeCommand(ctx: CommandContext, args: string): Promise<void> {
  const modes = ctx.host.get('interactionModes') as ModeService | undefined
  if (modes === undefined) { ctx.notice('warning', 'Interaction modes are unavailable in this profile.'); return }
  if (ctx.active.agent.status === 'running') {
    ctx.notice('warning', 'Wait for the running turn to finish or cancel it before changing mode.')
    return
  }
  const current = modes.current(ctx.active.agent)
  let target: InteractionMode | undefined
  if (args.trim() !== '') {
    const name = args.trim().toLowerCase().replace(/\s+/g, '-')
    if (!isInteractionMode(name)) {
      ctx.notice('warning', 'Usage: /mode [manual|accept-edits|plan|auto]')
      return
    }
    target = name
  }
  else {
    const choice = await showChoice(ctx.tui, ctx.palette, 'Interaction mode (current: ' + (current === 'custom' ? 'custom' : MODE_LABELS[current]) + ')',
      modes.available(ctx.active.agent).map(mode => ({ value: mode, label: (mode === current ? '* ' : '  ') + MODE_LABELS[mode], description: MODE_DESCRIPTIONS[mode] })),
      'Enter selects · Esc cancels', ctx.signal)
    if (choice !== undefined && isInteractionMode(choice)) target = choice
  }
  if (target === undefined || ctx.signal.aborted || target === current) return
  if (!modes.available(ctx.active.agent).includes(target)) {
    ctx.notice('warning', 'Mode "' + target + '" is unavailable in this profile.')
    return
  }
  if (target === 'auto') {
    const consent = await showChoice(ctx.tui, ctx.palette,
      'Auto mode · experimental\nFull file access with model review. Review may be wrong and spends extra tokens. PTC outer programs are not fully reviewed.', [
        { value: 'cancel', label: 'Keep current mode', description: 'Do not widen file access' },
        { value: 'confirm', label: 'Enable Auto for this session', description: 'Use the Host per-call reviewer; denied calls still ask you' },
      ], 'Choose explicitly · Esc cancels', ctx.signal)
    if (consent !== 'confirm' || ctx.signal.aborted) return
  }
  try {
    await modes.set(ctx.active.agent, target)
    ctx.notice('info', 'Mode: ' + MODE_LABELS[target])
    ctx.renderStatus()
  }
  catch (error) { ctx.notice('error', 'Could not change mode: ' + errorMessage(error)) }
}
