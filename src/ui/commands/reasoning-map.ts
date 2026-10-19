/**
 * `/reasoning map`: guided editor for the current model's thinking map.
 *
 * The wizard stages level additions, wire-value changes, and removals in
 * memory; one `settings.mutate` writes the result. The map lives in
 * `llm-pi-ai`: a `models` entry for hand-declared routes, or a
 * `modelOverrides` entry for catalog routes.
 *
 * @module dsh-native-tui/ui/commands/reasoning-map
 */

import {
  locateReasoningMap,
  reasoningMapSummary,
  reasoningMapWrite,
  reasoningWireLabel,
  sameNameReasoningEfforts,
  withReasoningLevel,
  withoutReasoningLevel,
  type ReasoningEfforts,
  type ReasoningMapRefusal,
} from '../../runtime/reasoning-map.js'
import {
  PROVIDER_REASONING_LEVELS,
  validateReasoningEfforts,
  type ProviderReasoningLevel,
} from '../../runtime/providers.js'
import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { LLM, SettingsService } from './services.js'
import { errorMessage } from './shared.js'

const ADD_LEVEL = '__add__'
const REMOVE_LEVEL = '__remove__'
const RESET_LEVELS = '__reset__'
const SAVE = '__save__'
const CANCEL = '__cancel__'

/** One `llm-pi-ai` settings descriptor, when the namespace is mounted. */
type ProviderSettings = ReturnType<SettingsService['describe']>[number] | undefined

function providerSettings(settings: SettingsService): ProviderSettings {
  return settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
}

/** Explain why the current model's map cannot be edited here. */
function refusalText(refusal: ReasoningMapRefusal, label: string, route: string, model: string): string {
  if (refusal === 'provider-missing') {
    return 'Model ' + label + ' is not served by a configured llm-pi-ai route; /reasoning map edits pi-ai routes only, and adapters such as CodeBuddy manage their own levels.'
  }
  if (refusal === 'model-not-listed') {
    return 'Model ' + model + ' is not listed in provider ' + route + '; run /provider models ' + route + ' or add the model to the profile before editing its reasoning map.'
  }
  return 'Model ' + label + ' has an invalid reasoningEfforts value; repair it in /settings edit llm-pi-ai before using the guided editor.'
}

/** Drop an explicit effort that the saved map no longer offers. */
async function dropUnmappedEffort(ctx: CommandContext, label: string, efforts: ReasoningEfforts): Promise<void> {
  const current = ctx.modelSelection.current
  const effort = current?.reasoningEffort
  if (current === undefined || effort === undefined || Object.hasOwn(efforts, effort)) return
  ctx.modelSelection.current = { provider: current.provider, model: current.model }
  try {
    await ctx.persistSelection()
  }
  catch (error) {
    ctx.notice('warning', 'The map was saved, but the previous effort could not be cleared: ' + errorMessage(error))
    return
  }
  ctx.notice('info', 'Reasoning effort "' + effort + '" is no longer mapped for ' + label + '; using the provider default. Use /reasoning to pick another level.')
}

/**
 * Open the guided reasoning-map editor for the current model.
 * @param ctx - command context.
 */
export async function openReasoningMapEditor(ctx: CommandContext): Promise<void> {
  const selected = ctx.modelSelection.current
  if (selected === undefined) {
    ctx.notice('warning', 'No active model selection is available.')
    return
  }
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const label = selected.provider + '/' + selected.model
  const descriptor = providerSettings(settings)
  if (descriptor === undefined) {
    ctx.notice('warning', 'The llm-pi-ai settings namespace is unavailable; reasoning maps are stored there.')
    return
  }
  const located = locateReasoningMap(descriptor.value.providers, selected.provider, selected.model, descriptor.user)
  if (!located.ok) {
    ctx.notice('warning', refusalText(located.reason, label, selected.provider, selected.model))
    return
  }

  const target = located.target
  let efforts: ReasoningEfforts = { ...target.efforts }
  let dirty = false
  let seeded = false
  let edited = false
  if (!target.disabled && Object.keys(efforts).length === 0) {
    const llm = ctx.host.get('llm') as LLM | undefined
    if (llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(selected.provider, selected.model)
        for (const candidate of info.reasoning?.efforts ?? []) {
          if (!PROVIDER_REASONING_LEVELS.includes(candidate.id as ProviderReasoningLevel)) continue
          const level = candidate.id as ProviderReasoningLevel
          efforts = withReasoningLevel(efforts, level, level === 'off' ? null : level)
        }
        seeded = PROVIDER_REASONING_LEVELS.some(level => level !== 'off' && Object.hasOwn(efforts, level))
        if (seeded) {
          // The seeded map is a real staged change, not a read-only preview:
          // saving it writes same-name wire values that the catalog may not use.
          dirty = true
          ctx.notice('info', 'No stored reasoning map for ' + label + '; staged the catalog levels with same-name wire values. Adjust them before saving if this endpoint expects different spellings.')
        }
      }
      catch {
        // Catalog details are optional; the editor still starts from an empty map.
      }
    }
  }

  while (!ctx.signal.aborted) {
    const current = target.disabled && !dirty
      ? 'disabled (reasoningEfforts: false)'
      : seeded && !edited ? 'catalog levels (staged same-name)' : reasoningMapSummary(efforts)
    const action = await showChoice(ctx.tui, ctx.palette, 'Reasoning map · ' + label + '\ncurrent: ' + current, [
      {
        value: ADD_LEVEL,
        label: 'Add or update a level',
        description: 'Pick off/minimal/low/medium/high/xhigh/max, then its wire spelling',
      },
      {
        value: REMOVE_LEVEL,
        label: 'Remove a level',
        description: 'Stop offering one level in /reasoning',
      },
      {
        value: RESET_LEVELS,
        label: 'Use same-name defaults',
        description: 'low → low, medium → medium, high → high',
      },
      {
        value: SAVE,
        label: dirty ? 'Save and apply' : 'Save',
        description: seeded && !edited
          ? 'Catalog levels are staged with same-name wire values; adjust them or save as-is'
          : 'Write to llm-pi-ai settings · applies to the next request',
      },
      {
        value: CANCEL,
        label: 'Cancel',
        description: dirty ? 'Discard staged changes' : 'Close without writing',
      },
    ], (dirty ? 'unsaved changes · ' : '') + 'Enter selects · Esc cancels', ctx.signal)

    if (action === undefined || action === CANCEL) {
      if (dirty) ctx.notice('info', 'Reasoning map unchanged for ' + label + '.')
      return
    }

    if (action === ADD_LEVEL) {
      const level = await showChoice(ctx.tui, ctx.palette, 'Level · ' + label, PROVIDER_REASONING_LEVELS.map(level => ({
        value: level,
        label: level,
        description: Object.hasOwn(efforts, level)
          ? 'current wire: ' + reasoningWireLabel(efforts[level])
          : level === 'off' ? 'not offered · wire may be omitted' : 'not offered',
      })), 'Enter selects · Esc goes back', ctx.signal)
      if (level === undefined) continue
      const typed = level as ProviderReasoningLevel
      const existing = Object.hasOwn(efforts, typed) ? efforts[typed] : undefined
      const initial = existing === null || existing === undefined ? (typed === 'off' ? '' : typed) : existing
      const raw = await showTextInput(
        ctx.tui,
        ctx.palette,
        'Wire value · ' + typed + ' · ' + label,
        typed === 'off' ? 'empty = omit the field' : typed,
        typed === 'off'
          ? 'Empty stores null (omit the field) · Enter saves · Esc goes back'
          : 'Non-empty spelling the gateway receives · Enter saves · Esc goes back',
        ctx.signal,
        initial,
        true,
      )
      if (raw === undefined) continue
      const wire = raw.trim()
      if (typed !== 'off' && wire === '') {
        ctx.notice('warning', 'A wire value is required for "' + typed + '"; the map is unchanged.')
        continue
      }
      efforts = withReasoningLevel(efforts, typed, wire === '' ? null : wire)
      dirty = true
      edited = true
      continue
    }

    if (action === REMOVE_LEVEL) {
      const offered = PROVIDER_REASONING_LEVELS.filter(level => Object.hasOwn(efforts, level))
      if (offered.length === 0) {
        ctx.notice('info', 'No levels are mapped for ' + label + '; add one first.')
        continue
      }
      const level = await showChoice(ctx.tui, ctx.palette, 'Remove level · ' + label, offered.map(level => ({
        value: level,
        label: level,
        description: 'current wire: ' + reasoningWireLabel(efforts[level]),
      })), 'Enter removes · Esc goes back', ctx.signal)
      if (level === undefined) continue
      const next = withoutReasoningLevel(efforts, level as ProviderReasoningLevel)
      if (!PROVIDER_REASONING_LEVELS.some(candidate => candidate !== 'off' && Object.hasOwn(next, candidate))) {
        ctx.notice('warning', 'Keep at least one thinking level; the map is unchanged.')
        continue
      }
      efforts = next
      dirty = true
      edited = true
      continue
    }

    if (action === RESET_LEVELS) {
      efforts = sameNameReasoningEfforts()
      dirty = true
      edited = true
      continue
    }

    try {
      validateReasoningEfforts(efforts)
    }
    catch (error) {
      ctx.notice('warning', 'Cannot save the reasoning map: ' + errorMessage(error))
      continue
    }
    const latest = providerSettings(settings)
    if (latest === undefined) {
      ctx.notice('warning', 'The llm-pi-ai settings namespace is no longer available.')
      return
    }
    const writable = locateReasoningMap(latest.value.providers, selected.provider, selected.model, latest.user)
    if (!writable.ok) {
      ctx.notice('warning', refusalText(writable.reason, label, selected.provider, selected.model))
      return
    }
    const write = reasoningMapWrite(writable.target, efforts)
    if (writable.target.storage === 'models' && !writable.target.userOwnsModelIndex) {
      const confirmed = await showChoice(ctx.tui, ctx.palette, 'Write the merged model list?', [
        {
          value: 'write',
          label: 'Write profile override',
          description: 'This route\'s models array comes from another layer; saving restates the merged list in your profile patch.',
        },
        { value: 'cancel', label: 'Cancel' },
      ], 'Enter selects · Esc goes back', ctx.signal)
      if (confirmed !== 'write') continue
    }
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'set', path: write.path, value: write.value }], latest.revision)
    }
    catch (error) {
      ctx.notice('error', 'Could not save the reasoning map: ' + errorMessage(error))
      continue
    }
    ctx.notice('info', 'Saved reasoning map for ' + label + ': ' + reasoningMapSummary(efforts) + ' · applies to the next request')
    await dropUnmappedEffort(ctx, label, efforts)
    ctx.renderStatus()
    return
  }
}
