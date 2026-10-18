/**
 * Small shared helpers the command handlers need.
 *
 * @module dsh-native-tui/ui/commands/shared
 */

/** The platform newline, used by every multi-line notice. */
export const NL = String.fromCharCode(10)

/**
 * Describe one thrown value for a notice line.
 * @param error - the caught value.
 * @returns its message, or the value itself when it is not an Error.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
