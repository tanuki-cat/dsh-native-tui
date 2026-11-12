/** Explicit updates for registry- and Git-installed third-party bundles. */
import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { PluginManagerService } from './services.js'
import { pluginChangeSuffix, withPluginProgress } from './plugin-result.js'
import { errorMessage, NL } from './shared.js'

const USAGE = 'Usage: /plugins versions <bundle> | /plugins update <bundle> [version] [git-spec]'

/** List newer registry versions, or update a registry/git bundle after review. */
export async function pluginUpdateCommand(ctx: CommandContext, manager: PluginManagerService, args: string): Promise<void> {
  const [command, name, requested, specArg, ...extra] = args.split(/\s+/u)
  if (name === undefined || extra.length > 0 || (command === 'versions' && (requested !== undefined || specArg !== undefined))) {
    ctx.notice('warning', USAGE); return
  }
  try {
    // Older Hosts and tests may expose only the version/update calls.
    const bundle = typeof manager.listBundles === 'function'
      ? (await manager.listBundles()).find(item => item.name === name)
      : undefined
    if (command === 'versions') {
      if (bundle?.update === 'git') {
        ctx.notice('info', gitGuidance(name))
        return
      }
      const listing = await manager.listVersions(name)
      if (listing.status === 'refused') { ctx.notice('warning', listing.problem + ': ' + listing.reason); return }
      ctx.notice('info', name + ' installed ' + listing.installed + ' · ' + listing.registry + NL
        + (listing.versions.length === 0 ? 'No newer versions.' : listing.versions.map(item => item.version
          + (item.prerelease ? ' (prerelease)' : '') + (item.bundle ? '' : ' (not a bundle)')
          + (item.incompatible === undefined ? '' : ' (incompatible)') + (item.deprecated === undefined ? '' : ' · deprecated: ' + item.deprecated)).join(NL))
        + (listing.omitted > 0 ? NL + listing.omitted + ' additional versions omitted by Host.' : ''))
      return
    }
    if (bundle?.update === 'git') {
      await updateGitBundle(ctx, manager, bundle, requested, specArg)
      return
    }
    if (specArg !== undefined) {
      ctx.notice('warning', 'A Git spec only applies to a bundle installed from a Git spec.')
      return
    }
    const listing = await manager.listVersions(name)
    if (listing.status === 'refused') { ctx.notice('warning', listing.problem + ': ' + listing.reason); return }
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

/** Explain why a Git-installed bundle has no registry version list. */
function gitGuidance(name: string): string {
  return name + ' is installed from a Git spec, so /plugins versions has no registry list.' + NL
    + 'Update it with the target package version and a Git spec pinned to a full commit:' + NL
    + '  /plugins update ' + name + ' <version> <git-spec>'
}

/**
 * Update a Git-installed bundle to another commit of the same repository.
 * The Host validates that the spec pins a full commit in the installed copy's
 * repository directory; TUI only collects the target version and the spec.
 */
async function updateGitBundle(
  ctx: CommandContext,
  manager: PluginManagerService,
  bundle: import('@deepseek-ai/dsh-plugin-manager').BundleInfo,
  requested: string | undefined,
  specArg: string | undefined,
): Promise<void> {
  const currentVersion = bundle.version ?? 'unknown'
  const version = requested ?? await showTextInput(ctx.tui, ctx.palette, 'Target version for ' + bundle.name, '',
    'The package version declared at the target commit; current ' + currentVersion + ' · Esc cancels', ctx.signal)
  if (version === undefined || ctx.signal.aborted || ctx.isCurrent?.() === false) return
  if (version.trim() === '') {
    ctx.notice('warning', 'Target version must not be empty.')
    return
  }
  const currentSpec = bundle.source === undefined
    ? 'unknown'
    : bundle.source.length > 120 ? bundle.source.slice(0, 117) + '...' : bundle.source
  const spec = specArg ?? await showTextInput(ctx.tui, ctx.palette, 'Git spec for ' + bundle.name, '',
    'Must pin a full commit; current ' + currentSpec + ' · Esc cancels', ctx.signal)
  if (spec === undefined || ctx.signal.aborted || ctx.isCurrent?.() === false) return
  if (spec.trim() === '') {
    ctx.notice('warning', 'Git spec must not be empty.')
    return
  }
  const choice = await showChoice(ctx.tui, ctx.palette, 'Update ' + bundle.name + ' ' + (bundle.version ?? '?') + ' → ' + version + ' (git)?', [
    { value: 'no', label: 'Cancel' },
    { value: 'yes', label: 'Update', description: spec },
  ], 'Installs the pinned commit; a failed attempt tries to restore the old version · Esc cancels', ctx.signal)
  if (choice !== 'yes' || ctx.signal.aborted || ctx.isCurrent?.() === false) return
  const outcome = await withPluginProgress(ctx, manager, requestId => manager.updateBundle(bundle.name, version, { spec, requestId }))
  ctx.notice(outcome.result.error === undefined ? 'info' : 'error', 'Update ' + outcome.from + ' → ' + outcome.to + ' · step ' + outcome.step + pluginChangeSuffix(outcome.result))
  if (outcome.restore !== undefined) ctx.notice(outcome.restore.error === undefined ? 'info' : 'error', 'Restore ' + outcome.from + pluginChangeSuffix(outcome.restore))
}
