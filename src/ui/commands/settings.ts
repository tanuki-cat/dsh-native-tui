/**
 * `/settings`: guided terminal configuration, the inline Host editor, and the
 * scripted escape hatches (`edit`, `items`, `set`).
 *
 * @module dsh-native-tui/ui/commands/settings
 */

import { settingsFields } from '../../runtime/settings.js'
import type { CommandContext } from './context.js'
import { openHostSettings } from './settings-host.js'
import { findSettingsNamespace, isSettingsConflict } from './settings-common.js'
import { openTuiSettings } from './settings-tui.js'
import type { SettingsService } from './services.js'
import { errorMessage, NL } from './shared.js'

export { openTuiSettings } from './settings-tui.js'

/** Render the Host settings summary used by `/settings` without a subcommand. */
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
  const lines = descriptors.map(descriptor => {
    const keys = Object.keys(descriptor.value)
    const secrets = descriptor.secrets !== undefined && descriptor.secrets.length > 0
      ? ' · ' + String(descriptor.secrets.length) + ' secret(s)'
      : ''
    return descriptor.ns + (keys.length === 0 ? '' : '  ' + keys.join(', ')) + secrets
  })
  ctx.notice('info', 'Host settings namespaces:' + NL + lines.join(NL)
    + NL + 'Use /settings host for the inline editor, or /settings set <ns> <json> for scripted writes.')
}

/** Resolve the service once for the command. */
function settingsService(ctx: CommandContext): SettingsService | undefined {
  return ctx.host.get('settings') as unknown as SettingsService | undefined
}

/** `/settings set <ns> <json-object>`: scripted merge write. */
async function setSettings(ctx: CommandContext, settings: SettingsService, args: string): Promise<void> {
  const rest = args.slice('set'.length).trim()
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
  const descriptor = findSettingsNamespace(settings, ns)
  if (descriptor === undefined) {
    ctx.notice('warning', 'No active settings namespace "' + ns + '".')
    return
  }
  if (descriptor.secrets !== undefined && descriptor.secrets.length > 0) {
    ctx.notice('warning', 'This namespace has secret fields; prefer the Web Models page for credentials. Writing the supplied non-secret fields now.')
  }
  try {
    try {
      await settings.update(ns, patch, descriptor.revision)
    }
    catch (error) {
      if (!isSettingsConflict(error)) throw error
      const fresh = findSettingsNamespace(settings, ns)
      if (fresh === undefined) {
        ctx.notice('warning', 'Namespace "' + ns + '" disappeared while saving.')
        return
      }
      await settings.update(ns, patch, fresh.revision)
    }
    ctx.notice('info', 'Settings updated: ' + ns + ' (live where the owner applies immediately)')
  }
  catch (error) {
    ctx.notice('error', 'Could not update settings: ' + errorMessage(error))
  }
}

/** The `/settings` command. */
export async function settingsCommand(ctx: CommandContext, args: string): Promise<void> {
  const settings = settingsService(ctx)
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const trimmed = args.trim()
  try {
    if (trimmed === '' || trimmed === 'tui') {
      await openTuiSettings(ctx)
      return
    }
    if (trimmed === 'host') {
      await openHostSettings(ctx, settings)
      return
    }
    if (trimmed === 'edit' || trimmed.startsWith('edit ')) {
      const ns = trimmed.slice('edit'.length).trim()
      if (ns === '') {
        await openHostSettings(ctx, settings)
        return
      }
      if (findSettingsNamespace(settings, ns) === undefined) {
        ctx.notice('warning', 'No active settings namespace "' + ns + '".')
        return
      }
      await openHostSettings(ctx, settings, ns)
      return
    }
    if (trimmed.startsWith('items ')) {
      const rest = trimmed.slice('items'.length).trim()
      const [ns, field] = rest.split(/\s+/u)
      if (ns === undefined || field === undefined) {
        ctx.notice('warning', 'Usage: /settings items <namespace> <array-field>')
        return
      }
      const descriptor = findSettingsNamespace(settings, ns)
      if (descriptor === undefined) {
        ctx.notice('warning', 'No active settings namespace "' + ns + '".')
        return
      }
      if (!settingsFields(descriptor.schema).includes(field)) {
        ctx.notice('warning', 'Settings field "' + ns + '.' + field + '" is not declared.')
        return
      }
      ctx.notice('info', 'Opening the inline editor for ' + ns + '; search for "' + field + '" to append, edit, or remove items.')
      await openHostSettings(ctx, settings, ns)
      return
    }
    if (trimmed.startsWith('set ')) {
      await setSettings(ctx, settings, trimmed)
      return
    }
    if (trimmed === 'list') {
      showHostSettings(ctx)
      return
    }
    ctx.notice('warning', 'Usage: /settings [tui | host | edit [ns] | items <ns> <field> | set <ns> <json>]')
  }
  catch (error) {
    ctx.notice('error', 'Could not read/write settings: ' + errorMessage(error))
  }
}
