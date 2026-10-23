/**
 * Path-addressed Host settings writes shared by the command handlers and the
 * runtime helpers that persist provider routes.
 *
 * The revision conflict is the only failure this module retries: the edits are
 * path-addressed and already user-confirmed, so replaying them against a fresh
 * revision cannot touch anything else. Validation failures must surface at once.
 *
 * @module dsh-native-tui/runtime/settings-write
 */

import type { SettingsPathOp } from './settings.js'

/** One namespace descriptor, narrowed to the fields a path write needs. */
export interface SettingsNamespace {
  readonly ns: string
  readonly value: Record<string, unknown>
  readonly revision: number
}

/** The settings slice a path write needs; the Host service satisfies it. */
export interface SettingsAccess {
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsNamespace[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Read one namespace descriptor, or undefined when it is not active. */
export function findSettingsNamespace(settings: SettingsAccess, ns: string): SettingsNamespace | undefined {
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
  settings: SettingsAccess,
  ns: string,
  ops: readonly SettingsPathOp[],
  revision: number,
): Promise<SettingsNamespace | undefined> {
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
