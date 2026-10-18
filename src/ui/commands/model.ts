/**
 * `/model` and `/reasoning`.
 *
 * @module dsh-native-tui/ui/commands/model
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { showChoice, showSearchChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { LLM } from './services.js'
import { errorMessage } from './shared.js'

/**
 * Apply one `provider/model` selection, or a bare model on the current provider.
 * @param ctx - command context.
 * @param llm - the Host catalogue.
 * @param target - the text after `/model`.
 */
export async function selectModel(ctx: CommandContext, llm: LLM, target: string): Promise<void> {
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
    ctx.setContextWindow(info.context?.contextWindow)
    const reasoning = info.reasoning
    let effort = ctx.modelSelection.current?.reasoningEffort
    if (effort !== undefined && reasoning?.efforts.some(candidate => candidate.id === effort) !== true)
      effort = undefined
    if (effort === undefined && reasoning?.defaultEffort !== undefined)
      effort = ReasoningEffortId(reasoning.defaultEffort)
    ctx.modelSelection.current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    ctx.notice('info', 'Model selected: ' + provider + '/' + model + ' (applies to the next step)')
    if (reasoning !== undefined && reasoning.efforts.length > 0) {
      ctx.notice('info', 'Reasoning efforts: ' + reasoning.efforts.map(candidate => candidate.id).join(', ') + ' — use /reasoning')
    }
    await ctx.persistSelection()
    ctx.renderStatus()
  }
  catch (error) {
    ctx.notice('error', 'Unroutable model ' + provider + '/' + model + ': ' + errorMessage(error))
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
  const items: Array<{ value: string; label: string; description?: string }> = []
  for (const provider of llm.listProviders()) {
    let models: readonly { id: string; name: string; description?: string }[] = []
    try {
      models = await llm.listModels(provider.id)
    }
    catch {
      continue
    }
    for (const model of models) {
      const value = provider.id + '/' + model.id
      const current = ctx.modelSelection.current?.provider === provider.id && ctx.modelSelection.current?.model === model.id
      items.push({
        value,
        label: (current ? '* ' : '  ') + value,
        description: model.name + (model.description === undefined ? '' : ' — ' + model.description),
      })
    }
  }
  if (items.length === 0) {
    ctx.notice('warning', 'The LLM catalog advertises no models.')
    return
  }
  const selectedModel = await showSearchChoice(ctx.tui, ctx.palette, 'Select model · ' + String(items.length) + ' available', items, 'Type to filter · ↑/↓ moves · Enter selects · Esc cancels', ctx.signal)
  if (selectedModel !== undefined) await selectModel(ctx, llm, selectedModel)
}

/** The `/reasoning` command. */
export async function reasoningCommand(ctx: CommandContext, args: string): Promise<void> {
  const llm = ctx.host.get('llm') as LLM | undefined
  const selected = ctx.modelSelection.current
  if (llm === undefined || selected === undefined) {
    ctx.notice('warning', 'No active model selection is available.')
    return
  }
  try {
    const info = await llm.resolveModelInfo(selected.provider, selected.model)
    const reasoning = info.reasoning
    if (reasoning === undefined || reasoning.efforts.length === 0) {
      ctx.notice('warning', 'Model ' + selected.provider + '/' + selected.model + ' exposes no reasoning efforts. Add reasoningEfforts to the provider model or choose another model.')
      return
    }
    const applyEffort = async (effort: string | undefined): Promise<void> => {
      const current = ctx.modelSelection.current
      if (current === undefined)
        return
      ctx.modelSelection.current = {
        provider: current.provider,
        model: current.model,
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      }
      ctx.notice('info', 'Reasoning effort: ' + (effort ?? 'provider default'))
      await ctx.persistSelection()
      ctx.renderStatus()
    }
    const currentEffort = selected.reasoningEffort
    if (args !== '') {
      const requested = args.trim().toLowerCase()
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
    await applyEffort(choice === '__default__' ? undefined : choice)
  }
  catch (error) {
    ctx.notice('error', 'Could not inspect reasoning efforts: ' + errorMessage(error))
  }
}
