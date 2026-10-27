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

/** Fallback width when the terminal cannot be measured, matching a conventional shell. */
const DEFAULT_COLUMNS = 80

/**
 * The terminal's current width, for handlers that align their own columns.
 *
 * The transcript wraps notices itself, so a handler building a table has to size
 * it first. The width is not always readable — a headless or redirected run has
 * no terminal, and tests stub the surface — so a missing measurement falls back
 * to a conventional shell width instead of throwing inside a command.
 * @param ctx - command context carrying the terminal surface.
 * @returns the usable column count, always positive.
 */
export function terminalColumns(ctx: { readonly tui: unknown }): number {
  try {
    const surface = ctx.tui as { readonly terminal?: { readonly columns?: unknown } } | undefined
    const columns = surface?.terminal?.columns
    if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) return Math.floor(columns)
  }
  catch {
    // Fall through to the default width.
  }
  return DEFAULT_COLUMNS
}
