/**
 * Shared persistence helpers for the settings command family.
 *
 * The retry itself lives in the runtime module so provider setup can use the
 * same conflict-only policy without importing the command layer.
 *
 * @module dsh-native-tui/ui/commands/settings-common
 */

import type { SettingsPathOp } from '../../runtime/settings.js'
import {
  findSettingsNamespace as findNamespace,
  isSettingsConflict,
  writeSettingsOps as writeNamespaceOps,
} from '../../runtime/settings-write.js'
import type { SettingsService } from './services.js'

/** One namespace descriptor as the Host service returns it. */
export type SettingsDescriptor = ReturnType<SettingsService['describe']>[number]

export { isSettingsConflict }

/** Read one namespace descriptor, or undefined when it is not active. */
export function findSettingsNamespace(settings: SettingsService, ns: string): SettingsDescriptor | undefined {
  return findNamespace(settings, ns) as SettingsDescriptor | undefined
}

/**
 * Apply path edits and return the namespace's refreshed descriptor.
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
  return await writeNamespaceOps(settings, ns, ops, revision) as SettingsDescriptor | undefined
}
