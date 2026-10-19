/**
 * Guided editor for one provider model's declared input modalities.
 *
 * Reached from `/provider input` (the current model by default) and from the
 * `/provider edit` route menu. The write lands in `llm-pi-ai`: a `models`
 * entry for hand-declared routes, or a `modelOverrides` entry for catalog
 * routes. Declaring `text + image` only admits images; it does not make a
 * text-only model read them.
 *
 * @module dsh-native-tui/ui/commands/model-input
 */

import {
  locateModelInput,
  modelInputSummary,
  modelInputWrite,
  type ModelInputRefusal,
} from '../../runtime/model-input.js'
import type { ProviderInputModality } from '../../runtime/providers.js'
import { showChoice, showSearchChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { LLM, SettingsService } from './services.js'
import { errorMessage } from './shared.js'

const TEXT_ONLY = 'text'
const TEXT_AND_IMAGE = 'image'
const INHERIT = 'inherit'
const CANCEL = 'cancel'

/** One `llm-pi-ai` settings descriptor, when the namespace is mounted. */
type ProviderSettings = ReturnType<SettingsService['describe']>[number] | undefined

function providerSettings(settings: SettingsService): ProviderSettings {
  return settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Explain why one model's declaration cannot be edited here. */
function refusalText(refusal: ModelInputRefusal, label: string, route: string, model: string): string {
  if (refusal === 'provider-missing') {
    return 'Model ' + label + ' is not served by a configured llm-pi-ai route; /provider input edits pi-ai routes only, while adapters such as CodeBuddy manage their own input declarations.'
  }
  if (refusal === 'model-not-listed') {
    return 'Model ' + model + ' is not listed in provider ' + route + '; run /provider models ' + route + ' or add the model before editing its input types.'
  }
  return 'Model ' + label + ' has an invalid input value; repair it with /settings edit llm-pi-ai before using the guided editor.'
}

/** Compare one stored declaration with the choice the editor is about to save. */
function sameInput(
  current: readonly ProviderInputModality[] | undefined,
  next: readonly ProviderInputModality[] | undefined,
): boolean {
  if (current === undefined || next === undefined) return current === next
  return current.length === next.length && current.every((modality, index) => modality === next[index])
}

/**
 * Open the guided input-type editor for one model.
 * @param ctx - command context.
 * @param route - target route; defaults to the current model's provider.
 * @param model - target model id; defaults to the current model.
 */
export async function openModelInputEditor(ctx: CommandContext, route?: string, model?: string): Promise<void> {
  const selected = ctx.modelSelection.current
  const targetRoute = route ?? selected?.provider
  const targetModel = model ?? selected?.model
  if (targetRoute === undefined || targetModel === undefined) {
    ctx.notice('warning', 'No model is selected. Use /provider input <provider/model>, or pick one with /model first.')
    return
  }
  const label = targetRoute + '/' + targetModel
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const descriptor = providerSettings(settings)
  if (descriptor === undefined) {
    ctx.notice('warning', 'The llm-pi-ai settings namespace is unavailable; input declarations are stored there.')
    return
  }
  const located = locateModelInput(descriptor.value.providers, targetRoute, targetModel, descriptor.user)
  if (!located.ok) {
    ctx.notice('warning', refusalText(located.reason, label, targetRoute, targetModel))
    return
  }

  const target = located.target
  const choice = await showChoice(ctx.tui, ctx.palette, 'Input types · ' + label + '\ncurrent: ' + modelInputSummary(target.declared), [
    {
      value: TEXT_ONLY,
      label: 'Text only',
      description: 'Declare input: [text]; image attachments are rejected for this model',
    },
    {
      value: TEXT_AND_IMAGE,
      label: 'Text + image',
      description: 'Declare input: [text, image]; only use this when the model or gateway accepts images',
    },
    ...(target.declared === undefined ? [] : [{
      value: INHERIT,
      label: 'Inherit route default',
      description: 'Remove the explicit input; route defaultInput or the installed catalog decides',
    }]),
    { value: CANCEL, label: 'Cancel' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (choice === undefined || choice === CANCEL)
    return

  const modalities = choice === TEXT_ONLY
    ? ['text'] as const
    : choice === TEXT_AND_IMAGE ? ['text', 'image'] as const : undefined
  if (sameInput(target.declared, modalities)) {
    ctx.notice('info', 'Input types unchanged for ' + label + '.')
    return
  }

  const latest = providerSettings(settings)
  if (latest === undefined) {
    ctx.notice('warning', 'The llm-pi-ai settings namespace is no longer available.')
    return
  }
  const writable = locateModelInput(latest.value.providers, targetRoute, targetModel, latest.user)
  if (!writable.ok) {
    ctx.notice('warning', refusalText(writable.reason, label, targetRoute, targetModel))
    return
  }
  const op = modelInputWrite(writable.target, modalities)
  if (writable.target.storage === 'models' && !writable.target.userOwnsModelIndex) {
    const confirmed = await showChoice(ctx.tui, ctx.palette, 'Write the merged model list?', [
      {
        value: 'write',
        label: 'Write profile override',
        description: 'This route\'s models array comes from another layer; saving restates the merged list in your profile patch.',
      },
      { value: 'cancel', label: 'Cancel' },
    ], 'Enter selects · Esc goes back', ctx.signal)
    if (confirmed !== 'write')
      return
  }
  try {
    await settings.mutate('llm-pi-ai', [op], latest.revision)
  }
  catch (error) {
    ctx.notice('error', 'Could not save input types for ' + label + ': ' + errorMessage(error))
    return
  }
  ctx.notice('info', 'Saved input types for ' + label + ': ' + modelInputSummary(modalities) + ' · applies to the next request')
}

/**
 * Pick one model of an already-chosen route, then edit its input types.
 *
 * The local profile lists hand-declared routes without needing credentials; a
 * catalog route falls back to the LLM listing, and an empty listing falls back
 * to a typed model id so the override remains reachable.
 * @param ctx - command context.
 * @param settings - the settings service.
 * @param llm - the Host catalogue, used for catalog routes.
 * @param route - provider route to edit.
 */
export async function chooseRouteModelInput(
  ctx: CommandContext,
  settings: SettingsService,
  llm: LLM,
  route: string,
): Promise<void> {
  const descriptor = providerSettings(settings)
  if (descriptor === undefined) {
    ctx.notice('warning', 'The llm-pi-ai settings namespace is unavailable; input declarations are stored there.')
    return
  }
  const rows: Array<{ id: string; name: string; summary: string }> = []
  const addRow = (id: string, name?: string): void => {
    if (id === '' || rows.some(row => row.id === id)) return
    const located = locateModelInput(descriptor.value.providers, route, id, descriptor.user)
    rows.push({
      id,
      name: name ?? id,
      summary: located.ok ? modelInputSummary(located.target.declared) : 'invalid declaration',
    })
  }
  const providers = descriptor.value.providers
  const profile = isRecord(providers) && isRecord(providers[route]) ? providers[route] : undefined
  const models = isRecord(profile) && Array.isArray(profile.models) ? profile.models : []
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    addRow(entry.id, typeof entry.name === 'string' ? entry.name : undefined)
  }
  if (rows.length === 0) {
    try {
      for (const candidate of await llm.listModels(route)) addRow(candidate.id, candidate.name)
    }
    catch {
      // A missing credential leaves the catalogue empty; the typed-id path below
      // still lets the operator declare a model override.
    }
  }
  if (rows.length === 0) {
    const typed = await showTextInput(ctx.tui, ctx.palette, 'Model id · ' + route, 'model-id', 'This catalogue is empty; type the exact model id · Esc cancels', ctx.signal)
    if (typed === undefined || typed.trim() === '') return
    await openModelInputEditor(ctx, route, typed.trim())
    return
  }
  const picked = await showSearchChoice(ctx.tui, ctx.palette, 'Model input types · ' + route + ' · ' + String(rows.length) + ' model(s)', rows.map(row => ({
    value: row.id,
    label: row.id,
    description: row.name + ' · ' + row.summary,
  })), 'Type to filter · Enter edits · Esc cancels', ctx.signal)
  if (picked !== undefined)
    await openModelInputEditor(ctx, route, picked)
}
