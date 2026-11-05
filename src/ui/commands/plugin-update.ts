/** Explicit updates for registry-installed third-party bundles. */
import { showChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { PluginManagerService } from './services.js'
import { pluginChangeSuffix, withPluginProgress } from './plugin-result.js'
import { errorMessage, NL } from './shared.js'

/** List newer versions or update a bundle after reviewing a concrete registry version. */
export async function pluginUpdateCommand(ctx: CommandContext, manager: PluginManagerService, args: string): Promise<void> {
  const [command, name, requested, ...extra] = args.split(/\s+/u)
  if (name === undefined || extra.length > 0 || (command === 'versions' && requested !== undefined)) {
    ctx.notice('warning', 'Usage: /plugins versions <bundle> | /plugins update <bundle> [version]'); return
  }
  try {
    const listing = await manager.listVersions(name)
    if (listing.status === 'refused') { ctx.notice('warning', listing.problem + ': ' + listing.reason); return }
    if (command === 'versions') {
      ctx.notice('info', name + ' installed ' + listing.installed + ' · ' + listing.registry + NL
        + (listing.versions.length === 0 ? 'No newer versions.' : listing.versions.map(item => item.version
          + (item.prerelease ? ' (prerelease)' : '') + (item.bundle ? '' : ' (not a bundle)')
          + (item.incompatible === undefined ? '' : ' (incompatible)') + (item.deprecated === undefined ? '' : ' · deprecated: ' + item.deprecated)).join(NL))
        + (listing.omitted > 0 ? NL + listing.omitted + ' additional versions omitted by Host.' : ''))
      return
    }
    const candidates = listing.versions.filter(item => item.bundle && item.incompatible === undefined)
    if (candidates.length === 0) { ctx.notice('warning', 'No compatible newer bundle versions.'); return }
    const version = requested ?? await showChoice(ctx.tui, ctx.palette, 'Update ' + name + ' from ' + listing.installed, candidates.map(item => ({
      value: item.version, label: item.version + (item.prerelease ? ' (prerelease)' : ''),
      description: item.deprecated ?? item.publishedAt,
    })), 'Select a version to review · Esc cancels', ctx.signal)
    if (version === undefined || ctx.signal.aborted || ctx.isCurrent?.() === false) return
    const selected = candidates.find(item => item.version === version)
    if (selected === undefined) { ctx.notice('warning', 'Choose a compatible version returned by /plugins versions ' + name); return }
    const choice = await showChoice(ctx.tui, ctx.palette, 'Update ' + name + ' ' + listing.installed + ' → ' + version + '?', [
      { value: 'no', label: 'Cancel' },
      { value: 'yes', label: 'Update', description: listing.registry + (selected.deprecated === undefined ? '' : ' · deprecated: ' + selected.deprecated) },
    ], 'May reload plugins; failed installation attempts to restore the old version · Esc cancels', ctx.signal)
    if (choice !== 'yes' || ctx.signal.aborted || ctx.isCurrent?.() === false) return
    const outcome = await withPluginProgress(ctx, manager, requestId => manager.updateBundle(name, version, { registry: listing.registry, requestId }))
    ctx.notice(outcome.result.error === undefined ? 'info' : 'error', 'Update ' + outcome.from + ' → ' + outcome.to + ' · step ' + outcome.step + pluginChangeSuffix(outcome.result))
    if (outcome.restore !== undefined) ctx.notice(outcome.restore.error === undefined ? 'info' : 'error', 'Restore ' + outcome.from + pluginChangeSuffix(outcome.restore))
  } catch (error) { ctx.notice('error', 'Could not update bundle: ' + errorMessage(error)) }
}
