/**
 * Shared persistence helpers for the settings command family.
 *
 * @module dsh-native-tui/ui/commands/settings-common
 */

import type { SettingsPathOp } from '../../runtime/settings.js'
import type { SettingsService } from './services.js'

/** One namespace descriptor as the Host service returns it. */
export type SettingsDescriptor = ReturnType<SettingsService['describe']>[number]

/** Read one namespace descriptor, or undefined when it is not active. */
export function findSettingsNamespace(settings: SettingsService, ns: string): SettingsDescriptor | undefined {
  return settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
}

/** Whether a failed write is the Host's stale-revision refusal. */
export function isSettingsConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { readonly code?: unknown }).code === 'SETTINGS_CONFLICT'
}

/**
 * Apply path edits and return the namespace's refreshed descriptor.
 *
 * A revision conflict means the profile moved while this editor was open. The
 * edits are path-addressed and already user-confirmed, so retrying once against
 * the fresh revision only touches those exact paths.
 * @param settings - Host settings service.
 * @param ns - namespace to write.
 * @param ops - path-addressed edits.
 * @param revision - revision the editor last read.
 * @returns the refreshed descriptor, or undefined when the namespace vanished.
 */
export async function writeSettingsOps(
  settings: SettingsService,
  ns: string,
  ops: readonly SettingsPathOp[],
  revision: number,
): Promise<SettingsDescriptor | undefined> {
  try {
    await settings.mutate(ns, ops, revision)
  }
  catch (error) {
    if (!isSettingsConflict(error)) throw error
    const fresh = findSettingsNamespace(settings, ns)
    if (fresh === undefined) return undefined
    await settings.mutate(ns, ops, fresh.revision)
  }
  return findSettingsNamespace(settings, ns)
}
