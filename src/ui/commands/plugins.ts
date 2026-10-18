/**
 * `/plugins`: bundles, the on-demand market, and per-entry enable/disable.
 *
 * @module dsh-native-tui/ui/commands/plugins
 */

import { showChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { PluginManagerService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** The `/plugins` command. */
export async function pluginsCommand(ctx: CommandContext, args: string): Promise<void> {
  const manager = ctx.host.get('pluginManager') as unknown as PluginManagerService | undefined
  if (manager === undefined) {
    ctx.notice('warning', 'The plugin manager is unavailable in this profile.')
    return
  }
  if (args === '') {
    try {
      const bundles = await manager.listBundles()
      if (bundles.length === 0) {
        ctx.notice('info', 'No bundles reported.')
        return
      }
      ctx.notice('info', 'Bundles (read-only; use dsh plugin or Web to change):' + NL + bundles.map(bundle => {
        const state = bundle.enabled ? '[on] ' : '[off] '
        return state + bundle.name + (bundle.version === undefined ? '' : '  ' + bundle.version)
          + (bundle.installed ? '' : '  (not installed)')
      }).join(NL) + NL + 'Use /plugins list for plugin entries; /plugins enable|disable <entryId> to change one.')
    } catch (error) {
      ctx.notice('error', 'Could not list bundles: ' + errorMessage(error))
    }
    return
  }
  if (args === 'list' || args.startsWith('list ')) {
    try {
      const query = args.startsWith('list ') ? args.slice('list '.length).trim().toLowerCase() : ''
      const allRows = await manager.listPlugins()
      const rows = query === '' ? allRows : allRows.filter(row => row.entryId.toLowerCase().includes(query) || row.moduleName.toLowerCase().includes(query))
      if (rows.length === 0) {
        ctx.notice('info', 'No plugin entries reported.')
        return
      }
      ctx.notice('info', 'Plugin entries' + (query === '' ? ' (first 40)' : ' matching "' + query + '"') + ':' + NL + rows.slice(0, 40).map(row => {
        const state = row.enabled ? '[on] ' : '[off] '
        const readOnly = row.readOnlyReason === undefined ? '' : '  (read-only: ' + row.readOnlyReason + ')'
        return state + row.entryId + '  ' + row.moduleName + readOnly
      }).join(NL) + (rows.length > 40 ? NL + '… ' + String(rows.length - 40) + ' more' : '') + NL
        + 'Use /plugins enable|disable <entryId>; the app may reload.')
    } catch (error) {
      ctx.notice('error', 'Could not list plugin entries: ' + errorMessage(error))
    }
    return
  }
  if (args === 'market' || args.startsWith('market ')) {
    const query = args.slice('market'.length).trim().toLowerCase()
    try {
      const bundles = await manager.listBundles()
      const rows = bundles.filter(bundle => bundle.installTarget !== undefined).filter(bundle =>
        query === ''
        || bundle.name.toLowerCase().includes(query)
        || (bundle.description ?? '').toLowerCase().includes(query))
      if (rows.length === 0) {
        ctx.notice('info', query === '' ? 'The official market has no on-demand bundles.' : 'No market bundle matches "' + query + '".')
        return
      }
      ctx.notice('info', 'Official market (on-demand):' + NL + rows.map(bundle => {
        const state = bundle.installed ? (bundle.enabled ? '[on] ' : '[off] ') : '[available] '
        const target = bundle.installTarget
        return state + bundle.name + (bundle.version === undefined ? '' : '  ' + bundle.version)
          + (bundle.description === undefined ? '' : NL + '  ' + bundle.description.slice(0, 140))
          + (target === undefined || bundle.installed ? '' : NL + '  install: /plugins install ' + target.spec)
      }).join(NL))
    } catch (error) {
      ctx.notice('error', 'Could not read the plugin market: ' + errorMessage(error))
    }
    return
  }
  if (args.startsWith('inspect ')) {
    const spec = args.slice('inspect '.length).trim()
    if (spec === '') {
      ctx.notice('warning', 'Usage: /plugins inspect <spec>')
      return
    }
    ctx.notice('info', 'Inspecting ' + spec + '…')
    try {
      const preview = await manager.inspect(spec)
      if (preview.status === 'refused') {
        ctx.notice('warning', 'Refused: ' + (preview.problem ?? 'unknown') + (preview.reason === undefined ? '' : ' · ' + preview.reason))
        return
      }
      ctx.notice('info', 'Accepted: ' + (preview.name ?? spec)
        + (preview.version === undefined ? '' : '@' + preview.version)
        + ' · ' + (preview.kind ?? 'unknown')
        + (preview.bundle === false ? ' · no bundle patch' : '')
        + (preview.description === undefined ? '' : NL + preview.description))
    } catch (error) {
      ctx.notice('error', 'Could not inspect ' + spec + ': ' + errorMessage(error))
    }
    return
  }
  if (args.startsWith('install ')) {
    const spec = args.slice('install '.length).trim()
    if (spec === '') {
      ctx.notice('warning', 'Usage: /plugins install <spec>')
      return
    }
    ctx.notice('info', 'Inspecting ' + spec + '…')
    try {
      const preview = await manager.inspect(spec)
      if (preview.status === 'refused') {
        ctx.notice('warning', 'Refused: ' + (preview.problem ?? 'unknown') + (preview.reason === undefined ? '' : ' · ' + preview.reason))
        return
      }
      const label = preview.name ?? spec
      const confirmed = await showChoice(
        ctx.tui,
        ctx.palette,
        'Install ' + label + '?',
        [
          { value: 'yes', label: 'Continue', description: 'pnpm installs the package; the profile may reload' },
          { value: 'no', label: 'Cancel' },
        ],
        'Enter selects · Esc cancels',
        ctx.signal,
      )
      if (confirmed !== 'yes') return
      ctx.notice('info', 'Installing ' + label + '… pnpm may take a while.')
      const result = await manager.installBundle(spec, { enabled: true })
      const suffix = result.error === undefined
        ? ' · ' + result.application
        : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
      ctx.notice(result.error === undefined ? 'info' : 'error', 'install ' + label + suffix)
    } catch (error) {
      ctx.notice('error', 'Could not install ' + spec + ': ' + errorMessage(error))
    }
    return
  }
  if (args.startsWith('remove ')) {
    const name = args.slice('remove '.length).trim()
    if (name === '') {
      ctx.notice('warning', 'Usage: /plugins remove <bundleName>')
      return
    }
    try {
      const bundle = (await manager.listBundles()).find(item => item.name === name)
      if (bundle === undefined) {
        ctx.notice('warning', 'Unknown bundle "' + name + '".')
        return
      }
      if (bundle.removable === false) {
        ctx.notice('warning', 'Bundle "' + name + '" is not removable in this profile.')
        return
      }
      const confirmed = await showChoice(
        ctx.tui,
        ctx.palette,
        'Remove ' + name + '?',
        [
          { value: 'yes', label: 'Continue', description: 'pnpm removes the dependency and the profile may reload' },
          { value: 'no', label: 'Cancel' },
        ],
        'Enter selects · Esc cancels',
        ctx.signal,
      )
      if (confirmed !== 'yes') return
      ctx.notice('info', 'Removing ' + name + '… pnpm may take a while.')
      const result = await manager.removeBundle(name)
      const suffix = result.error === undefined
        ? ' · ' + result.application
        : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
      ctx.notice(result.error === undefined ? 'info' : 'error', 'remove ' + name + suffix)
    } catch (error) {
      ctx.notice('error', 'Could not remove ' + name + ': ' + errorMessage(error))
    }
    return
  }
  if (args.startsWith('enable ') || args.startsWith('disable ')) {
    const verb = args.startsWith('enable ') ? 'enable' : 'disable'
    const id = args.slice(verb.length).trim()
    if (id === '') {
      ctx.notice('warning', 'Usage: /plugins ' + verb + ' <entryId>')
      return
    }
    try {
      const row = (await manager.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) {
        ctx.notice('warning', 'Unknown plugin entry "' + id + '". Use /plugins list.')
        return
      }
      if (row.readOnlyReason !== undefined) {
        ctx.notice('warning', 'Plugin entry "' + id + '" is read-only: ' + row.readOnlyReason)
        return
      }
      const confirmed = await showChoice(
        ctx.tui,
        ctx.palette,
        verb + ' plugin ' + id + '?',
        [
          { value: 'yes', label: 'Continue', description: 'The profile may reload and interrupt this terminal' },
          { value: 'no', label: 'Cancel' },
        ],
        'Enter selects · Esc cancels',
        ctx.signal,
      )
      if (confirmed !== 'yes') return
      const result = await manager.setPluginEnabled(id, verb === 'enable')
      const suffix = result.error === undefined
        ? ' · ' + result.application
        : ' · ' + result.error.code + (result.error.message === undefined ? '' : ' ' + result.error.message)
      ctx.notice(result.error === undefined ? 'info' : 'error', verb + ' ' + id + suffix)
    } catch (error) {
      ctx.notice('error', 'Could not ' + verb + ' plugin: ' + errorMessage(error))
    }
    return
  }
  ctx.notice('warning', 'Usage: /plugins [list | market [query] | inspect <spec> | install <spec> | remove <bundle> | enable <entryId> | disable <entryId>]')
}
