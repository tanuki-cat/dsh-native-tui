/**
 * `/settings`: the interactive editor, the host summary, and the scripted
 * `edit` / `items` / `set` subcommands.
 *
 * @module dsh-native-tui/ui/commands/settings
 */

import type { DisplayMode } from '../../config.js'
import { settingsChildFields, settingsFields, settingsSetAt, settingsValueAt } from '../../runtime/settings.js'
import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { SettingsService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** The host settings summary. */
export function showHostSettings(ctx: CommandContext): void {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const descriptors = settings.describe({ redactSecrets: true })
  if (descriptors.length === 0) {
    ctx.notice('info', 'No configurable plugin namespaces are active.')
    return
  }
  ctx.notice('info', 'Host settings namespaces:' + NL + descriptors.map(descriptor => {
    const keys = Object.keys(descriptor.value)
    return descriptor.ns + (keys.length === 0 ? '' : '  ' + keys.join(', '))
  }).join(NL) + NL + 'Use /settings edit <ns>, /settings items <ns> <field>, or /settings set <ns> <json>.')
}

/** The terminal-level settings editor. */
export async function openTuiSettings(ctx: CommandContext): Promise<void> {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const modes: readonly DisplayMode[] = ['hidden', 'compact', 'detailed']
  const descriptorFor = () => settings.describe({ redactSecrets: true }).find(row => row.ns === 'native-tui')
  while (!ctx.signal.aborted) {
    const descriptor = descriptorFor()
    if (descriptor === undefined) {
      ctx.notice('warning', 'native-tui settings are not registered in this profile; edit the profile config instead.')
      return
    }
    const thinking = String(descriptor.value.thinkingDisplay ?? ctx.config.thinkingDisplay)
    const runCode = String(descriptor.value.runCodeDisplay ?? ctx.config.runCodeDisplay)
    const maxEntries = String(descriptor.value.maxTranscriptEntries ?? ctx.config.maxTranscriptEntries)
    const theme = String(descriptor.value.theme ?? ctx.config.theme)
    const fullscreen = String(descriptor.value.fullscreen ?? ctx.config.fullscreen)
    const pick = await showChoice(ctx.tui, ctx.palette, 'TUI settings', [
      { value: 'thinking', label: 'Thinking display', description: 'current: ' + thinking + ' · hidden | compact | detailed' },
      { value: 'runCode', label: 'Code execution display', description: 'run_code/bash/pwsh · current: ' + runCode + ' · hidden | compact | detailed' },
      { value: 'entries', label: 'Transcript entries', description: 'current: ' + maxEntries + ' · applies immediately' },
      { value: 'theme', label: 'Theme', description: 'current: ' + theme + ' · restart required' },
      { value: 'fullscreen', label: 'Fullscreen', description: 'current: ' + fullscreen + ' · restart required' },
      { value: 'host', label: 'Host settings…', description: 'Advanced plugin namespaces, arrays, and JSON values' },
      { value: 'done', label: 'Done' },
    ], 'Enter selects · Esc closes', ctx.signal)
    if (pick === undefined || pick === 'done') return
    if (pick === 'host') {
      showHostSettings(ctx)
      return
    }
    const latest = descriptorFor()
    if (latest === undefined) {
      ctx.notice('warning', 'native-tui settings are no longer available.')
      return
    }
    let field: string
    let rawValue: string | boolean | number | undefined
    if (pick === 'thinking' || pick === 'runCode') {
      field = pick === 'thinking' ? 'thinkingDisplay' : 'runCodeDisplay'
      const value = await showChoice(ctx.tui, ctx.palette, pick === 'thinking' ? 'Thinking display' : 'Code execution display',
        modes.map(mode => ({ value: mode, label: mode, description: mode === (pick === 'thinking' ? thinking : runCode) ? 'current' : 'apply immediately' })),
        'Enter applies · Esc cancels', ctx.signal)
      if (value === undefined) continue
      rawValue = value
    }
    else if (pick === 'entries') {
      field = 'maxTranscriptEntries'
      const raw = await showTextInput(ctx.tui, ctx.palette, 'Transcript entries', maxEntries, 'Integer >= 50; applies immediately · Esc cancels', ctx.signal, maxEntries)
      if (raw === undefined) continue
      const parsed = Number(raw)
      if (!Number.isSafeInteger(parsed) || parsed < 50) {
        ctx.notice('warning', 'Transcript entries must be an integer >= 50.')
        continue
      }
      rawValue = parsed
    }
    else if (pick === 'theme') {
      field = 'theme'
      const value = await showChoice(ctx.tui, ctx.palette, 'Theme', ['auto', 'dark', 'light', 'plain'].map(value => ({
        value,
        label: value,
        description: value === theme ? 'current' : 'restart TUI to apply',
      })), 'Enter saves · Esc cancels', ctx.signal)
      if (value === undefined) continue
      rawValue = value
    }
    else {
      field = 'fullscreen'
      const value = await showChoice(ctx.tui, ctx.palette, 'Fullscreen', [
        { value: 'false', label: 'off', description: fullscreen === 'false' ? 'current' : 'restart TUI to apply' },
        { value: 'true', label: 'on', description: fullscreen === 'true' ? 'current' : 'restart TUI to apply' },
      ], 'Enter saves · Esc cancels', ctx.signal)
      if (value === undefined) continue
      rawValue = value === 'true'
    }
    try {
      await settings.update('native-tui', { [field]: rawValue }, latest.revision)
      ctx.notice('info', 'Updated native-tui.' + field + ': ' + String(rawValue)
        + (field === 'theme' || field === 'fullscreen' ? ' · restart TUI to apply' : ''))
    }
    catch (error) {
      ctx.notice('error', 'Could not update native-tui settings: ' + errorMessage(error))
    }
  }
}

/** The `/settings` command. */
export async function settingsCommand(ctx: CommandContext, args: string): Promise<void> {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  try {
    if (args === '' || args === 'tui') {
      await openTuiSettings(ctx)
      return
    }
    if (args === 'host') {
      showHostSettings(ctx)
      return
    }
    if (args === 'edit' || args.startsWith('edit ')) {
      await editSettings(ctx, settings, args)
      return
    }
    if (args.startsWith('items ')) {
      await editSettingsArray(ctx, settings, args)
      return
    }
    if (args.startsWith('set ')) {
      await setSettings(ctx, settings, args)
      return
    }
    const descriptors = settings.describe({ redactSecrets: true })
    if (descriptors.length === 0) {
      ctx.notice('info', 'No configurable plugin namespaces are active.')
      return
    }
    ctx.notice('info', 'Settings namespaces (read-only unless using /settings set):' + NL + descriptors.map(descriptor => {
      const keys = Object.keys(descriptor.value)
      return descriptor.ns + (keys.length === 0 ? '' : '  ' + keys.join(', '))
    }).join(NL))
  }
  catch (error) {
    ctx.notice('error', 'Could not read/write settings: ' + errorMessage(error))
  }
}

/** `/settings edit [namespace]`: walk one schema field and write it. */
async function editSettings(ctx: CommandContext, settings: SettingsService, args: string): Promise<void> {
  const nsArg = args.slice('edit'.length).trim()
  const descriptors = settings.describe({ redactSecrets: true })
  let descriptor = nsArg === '' ? undefined : descriptors.find(row => row.ns === nsArg)
  if (nsArg !== '' && descriptor === undefined) {
    ctx.notice('warning', 'No active settings namespace "' + nsArg + '".')
    return
  }
  if (descriptor === undefined) {
    const namespaceChoice = await showChoice(
      ctx.tui,
      ctx.palette,
      'Settings namespace',
      descriptors.map(row => ({
        value: row.ns,
        label: row.ns,
        description: Object.keys(row.value).join(', '),
      })),
      'Enter selects · Esc cancels',
      ctx.signal,
    )
    if (namespaceChoice === undefined) return
    descriptor = descriptors.find(row => row.ns === namespaceChoice)
  }
  if (descriptor === undefined) return
  const target = descriptor
  const fields = settingsFields(target.schema)
  if (fields.length === 0) {
    ctx.notice('warning', 'Namespace "' + target.ns + '" exposes no editable live fields.')
    return
  }
  const field = await showChoice(
    ctx.tui,
    ctx.palette,
    'Settings · ' + target.ns,
    fields.map(name => ({
      value: name,
      label: name,
      description: JSON.stringify(target.value[name] ?? null).slice(0, 120),
    })),
    'Enter selects · Esc cancels',
    ctx.signal,
  )
  if (field === undefined) return
  const path: string[] = [field]
  while (path.length < 4) {
    const children = settingsChildFields(target.schema, path)
    if (children.length === 0) break
    const nested = await showChoice(
      ctx.tui,
      ctx.palette,
      'Settings · ' + target.ns + '.' + path.join('.'),
      [
        { value: '__json__', label: 'Edit this object as JSON', description: 'Replace the whole object' },
        ...children.map(name => ({
          value: name,
          label: name,
          description: JSON.stringify(settingsValueAt(target.value, [...path, name]) ?? null).slice(0, 120),
        })),
      ],
      'Enter selects · Esc cancels',
      ctx.signal,
    )
    if (nested === undefined) return
    if (nested === '__json__') break
    path.push(nested)
  }
  if (target.secrets?.some(secret => path.every((part, index) => secret.path[index] === part)) === true) {
    ctx.notice('warning', 'Field "' + path.join('.') + '" is secret; use the Web Models page instead of terminal history.')
    return
  }
  const dotted = path.join('.')
  const current = settingsValueAt(target.value, path)
  const raw = await showTextInput(
    ctx.tui,
    ctx.palette,
    'Set ' + target.ns + '.' + dotted,
    'JSON value (current: ' + JSON.stringify(current ?? null).slice(0, 80) + ')',
    'Enter writes · Esc cancels',
    ctx.signal,
  )
  if (raw === undefined) return
  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch (error) {
    ctx.notice('error', 'Invalid JSON: ' + errorMessage(error))
    return
  }
  try {
    let patch: Record<string, unknown>
    if (path.length === 1) {
      patch = { [field]: value }
    }
    else {
      const top = target.value[field]
      let root: unknown
      try {
        root = structuredClone(top)
      }
      catch {
        root = top === undefined ? {} : JSON.parse(JSON.stringify(top))
      }
      root = settingsSetAt(root, path.slice(1), value)
      patch = { [field]: root }
    }
    await settings.update(target.ns, patch, target.revision)
    ctx.notice('info', 'Updated ' + target.ns + '.' + dotted)
  }
  catch (error) {
    ctx.notice('error', 'Could not update settings: ' + errorMessage(error))
  }
}

/** `/settings items <ns> <field>`: edit one array entry. */
async function editSettingsArray(ctx: CommandContext, settings: SettingsService, args: string): Promise<void> {
  const rest = args.slice('items '.length).trim()
  const [ns, field] = rest.split(/\s+/u)
  if (ns === undefined || field === undefined) {
    ctx.notice('warning', 'Usage: /settings items <namespace> <array-field>')
    return
  }
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
  if (descriptor === undefined) {
    ctx.notice('warning', 'No active settings namespace "' + ns + '".')
    return
  }
  const current = descriptor.value[field]
  if (!Array.isArray(current)) {
    ctx.notice('warning', 'Settings field "' + ns + '.' + field + '" is not an array.')
    return
  }
  const picked = await showChoice(ctx.tui, ctx.palette, 'Array · ' + ns + '.' + field, [
    ...current.map((item, index) => ({
      value: String(index),
      label: String(index) + '. ' + JSON.stringify(item ?? null).slice(0, 100),
      description: 'array item',
    })),
    { value: '__append__', label: '+ Append JSON item', description: 'Add one item to the end' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (picked === undefined)
    return
  let array: unknown[]
  try {
    array = structuredClone(current) as unknown[]
  }
  catch {
    array = JSON.parse(JSON.stringify(current)) as unknown[]
  }
  if (picked === '__append__') {
    const raw = await showTextInput(ctx.tui, ctx.palette, 'Append ' + ns + '.' + field, 'JSON value', 'Enter writes · Esc cancels', ctx.signal)
    if (raw === undefined)
      return
    try {
      array.push(JSON.parse(raw))
    }
    catch (error) {
      ctx.notice('error', 'Invalid JSON: ' + errorMessage(error))
      return
    }
  }
  else {
    const index = Number(picked)
    if (!Number.isSafeInteger(index) || index < 0 || index >= array.length) {
      ctx.notice('warning', 'No array item at index ' + picked + '.')
      return
    }
    const action = await showChoice(ctx.tui, ctx.palette, 'Item ' + String(index) + ' · ' + ns + '.' + field, [
      { value: 'edit', label: 'Edit JSON', description: 'Replace this item' },
      { value: 'remove', label: 'Remove', description: 'Delete this item' },
      { value: 'back', label: 'Back' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (action === 'remove') {
      array.splice(index, 1)
    }
    else if (action === 'edit') {
      const raw = await showTextInput(ctx.tui, ctx.palette, 'Set item ' + String(index) + ' · ' + ns + '.' + field, 'JSON value (current: ' + JSON.stringify(array[index] ?? null).slice(0, 80) + ')', 'Enter writes · Esc cancels', ctx.signal)
      if (raw === undefined)
        return
      try {
        array[index] = JSON.parse(raw)
      }
      catch (error) {
        ctx.notice('error', 'Invalid JSON: ' + errorMessage(error))
        return
      }
    }
    else {
      return
    }
  }
  try {
    await settings.update(ns, { [field]: array }, descriptor.revision)
    ctx.notice('info', 'Updated array ' + ns + '.' + field + ' (' + String(array.length) + ' items)')
  }
  catch (error) {
    ctx.notice('error', 'Could not update settings array: ' + errorMessage(error))
  }
}

/** `/settings set <ns> <json-object>`. */
async function setSettings(ctx: CommandContext, settings: SettingsService, args: string): Promise<void> {
  const rest = args.slice('set '.length).trim()
  const space = rest.indexOf(' ')
  const ns = space === -1 ? rest : rest.slice(0, space)
  const json = space === -1 ? '' : rest.slice(space + 1).trim()
  if (ns === '' || json === '') {
    ctx.notice('warning', 'Usage: /settings set <namespace> <json-object>')
    return
  }
  let patch: unknown
  try {
    patch = JSON.parse(json)
  }
  catch (error) {
    ctx.notice('error', 'Invalid JSON: ' + errorMessage(error))
    return
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    ctx.notice('warning', 'Settings patch must be a JSON object.')
    return
  }
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
  if (descriptor === undefined) {
    ctx.notice('warning', 'No active settings namespace "' + ns + '".')
    return
  }
  if (descriptor.secrets !== undefined && descriptor.secrets.length > 0) {
    ctx.notice('warning', 'This namespace has secret fields; prefer the Web Models page for credentials. Writing non-secret fields now.')
  }
  await settings.update(ns, patch as object, descriptor.revision)
  ctx.notice('info', 'Settings updated: ' + ns + ' (live where the owner applies immediately)')
}
