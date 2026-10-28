/**
 * `/model` and `/reasoning`.
 *
 * @module dsh-native-tui/ui/commands/model
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { sameModelSelection } from '../../runtime/model-selection.js'
import { showChoice } from '../dialogs.js'
import type { CommandContext, ModelSelectionState } from './context.js'
import { openReasoningMapEditor } from './reasoning-map.js'
import type { LLM } from './services.js'
import { errorMessage } from './shared.js'
import { showModelPicker } from '../model-picker.js'

const modelRequests = new WeakMap<ModelSelectionState, object>()

/**
 * Apply one `provider/model` selection, or a bare model on the current provider.
 * @param ctx - command context.
 * @param llm - the Host catalogue.
 * @param target - the text after `/model`.
 */
export async function selectModel(ctx: CommandContext, llm: LLM, target: string): Promise<void> {
  if (ctx.signal.aborted || ctx.isCurrent?.() === false) return
  const owner = ctx.modelSelection
  const ticket = {}
  modelRequests.set(owner, ticket)
  const initial = owner.current
  const isCurrent = (): boolean => !ctx.signal.aborted && ctx.isCurrent?.() !== false && modelRequests.get(owner) === ticket
  const slash = target.indexOf('/')
  const provider = slash === -1
    ? (ctx.modelSelection.current?.provider ?? ctx.active.agent.options.provider ?? 'deepseek-official')
    : target.slice(0, slash)
  const model = slash === -1 ? target : target.slice(slash + 1)
  if (provider === '' || model === '') {
    ctx.notice('warning', 'Usage: /model [provider/model]')
    return
  }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    if (!isCurrent() || !sameModelSelection(owner.current, initial)) return
    ctx.setContextWindow(info.context?.contextWindow, info.defaultMaxTokens)
    const reasoning = info.reasoning
    let effort = ctx.modelSelection.current?.reasoningEffort
    if (effort !== undefined && reasoning?.efforts.some(candidate => candidate.id === effort) !== true)
      effort = undefined
    const next = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    owner.current = next
    ctx.notice('info', 'Model selected: ' + provider + '/' + model + ' (applies to the next step)')
    if (reasoning !== undefined && reasoning.efforts.length > 0) {
      ctx.notice('info', 'Reasoning efforts: ' + reasoning.efforts.map(candidate => candidate.id).join(', ') + ' — use /reasoning')
    }
    await ctx.persistSelection(next)
    if (isCurrent()) ctx.renderStatus()
  }
  catch (error) {
    if (isCurrent()) ctx.notice('error', 'Unroutable model ' + provider + '/' + model + ': ' + errorMessage(error))
  }
}

/** The `/model` command. */
export async function modelCommand(ctx: CommandContext, args: string): Promise<void> {
  const llm = ctx.host.get('llm') as LLM | undefined
  if (llm === undefined) {
    ctx.notice('warning', 'The LLM catalog service is unavailable.')
    return
  }
  if (args !== '') {
    await selectModel(ctx, llm, args)
    return
  }
  const selectedModel = await showModelPicker(ctx, llm)
  if (selectedModel !== undefined) await selectModel(ctx, llm, selectedModel)
}

async function changeReasoningEffort(ctx: CommandContext, args: string, cycle = false, ownsShortcut = (): boolean => true): Promise<void> {
  const isCurrent = (): boolean => ctx.isCurrent?.() !== false && ownsShortcut()
  if (ctx.signal.aborted || !isCurrent()) return
  const selected = ctx.modelSelection.current
  if (selected === undefined) {
    ctx.notice('warning', 'No active model selection is available.')
    return
  }
  const requested = args.trim().toLowerCase()
  if (requested === 'map') {
    await openReasoningMapEditor(ctx)
    return
  }
  const llm = ctx.host.get('llm') as LLM | undefined
  if (llm === undefined) {
    ctx.notice('warning', 'The LLM catalog service is unavailable.')
    return
  }
  try {
    const info = await llm.resolveModelInfo(selected.provider, selected.model)
    if (ctx.signal.aborted || !isCurrent() || !sameModelSelection(ctx.modelSelection.current, selected)) return
    const reasoning = info.reasoning
    if (reasoning === undefined || reasoning.efforts.length === 0) {
      ctx.notice('warning', 'Model ' + selected.provider + '/' + selected.model + ' exposes no reasoning efforts. Use /reasoning map to add levels and wire values, or choose another model.')
      return
    }
    const applyEffort = async (effort: string | undefined): Promise<void> => {
      const current = ctx.modelSelection.current
      if (!sameModelSelection(current, selected) || current === undefined || ctx.signal.aborted || !isCurrent()) return
      const next = {
        provider: current.provider,
        model: current.model,
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      }
      ctx.modelSelection.current = next
      ctx.notice('info', 'Reasoning effort: ' + (effort ?? 'provider default'))
      ctx.renderStatus()
      await ctx.persistSelection(next)
    }
    const currentEffort = selected.reasoningEffort
    if (cycle) {
      const effective = currentEffort ?? reasoning.defaultEffort
      const index = reasoning.efforts.findIndex(candidate => candidate.id === effective)
      const next = reasoning.efforts[(index + 1) % reasoning.efforts.length]!.id
      if (next !== currentEffort) await applyEffort(next)
      return
    }
    if (args !== '') {
      if (requested === 'default' || requested === 'auto' || requested === 'clear') {
        await applyEffort(undefined)
        return
      }
      if (!reasoning.efforts.some(candidate => candidate.id === requested)) {
        ctx.notice('warning', 'Unknown reasoning effort "' + requested + '". Available: ' + reasoning.efforts.map(candidate => candidate.id).join(', '))
        return
      }
      await applyEffort(requested)
      return
    }
    const items: Array<{ value: string; label: string; description?: string }> = [{
      value: '__default__',
      label: (currentEffort === undefined ? '* ' : '  ') + 'provider default',
      description: 'Omit an explicit reasoning effort',
    }]
    for (const candidate of reasoning.efforts) {
      items.push({
        value: candidate.id,
        label: (candidate.id === currentEffort ? '* ' : '  ') + candidate.id,
        description: candidate.name + (candidate.description === undefined ? '' : ' — ' + candidate.description),
      })
    }
    items.push({
      value: '__map__',
      label: 'Edit reasoning map…',
      description: 'Add, change, or remove levels and their wire values',
    })
    const choice = await showChoice(
      ctx.tui,
      ctx.palette,
      'Reasoning effort (current: ' + (currentEffort ?? 'provider default') + ')',
      items,
      'Enter selects · Esc cancels',
      ctx.signal,
    )
    if (choice === undefined)
      return
    if (choice === '__map__') {
      await openReasoningMapEditor(ctx)
      return
    }
    await applyEffort(choice === '__default__' ? undefined : choice)
  }
  catch (error) {
    if (!ctx.signal.aborted && isCurrent())
      ctx.notice('error', 'Could not inspect reasoning efforts: ' + errorMessage(error))
  }
}

/** The `/reasoning` command. */
export async function reasoningCommand(ctx: CommandContext, args: string): Promise<void> {
  await changeReasoningEffort(ctx, args)
}

/** Cycle the model's advertised levels; isCurrent rejects stale session shortcuts. */
export async function cycleReasoningEffort(ctx: CommandContext, isCurrent = (): boolean => true): Promise<void> {
  await changeReasoningEffort(ctx, '', true, isCurrent)
}
