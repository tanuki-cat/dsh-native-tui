/**
 * Keep Node's process warnings off the terminal while the TUI owns the screen.
 *
 * A dependency can reach an experimental Node API for the first time mid-turn:
 * the PTC runtime strips TypeScript when it first runs `run_code`. Node prints
 * the warning straight to stderr, wherever the cursor happens to be, so it lands
 * on top of the editor and status rows and a live frame stays corrupt until the
 * next full repaint. Warnings are informational, so hold them until the terminal
 * is restored instead of breaking a live frame.
 *
 * @module dsh-native-tui/ui/warnings
 */

/** Warnings held while the terminal is owned by the UI. */
export interface WarningGuard {
  /**
   * Restore the original emitter.
   * @returns the warning lines collected while held, oldest first.
   */
  restore(): readonly string[]
}

/** Most recent warnings kept; older ones are dropped. */
const HELD_WARNING_LIMIT = 20

/**
 * Read one warning as the single-line label Node would print.
 * @param warning - message or error handed to `process.emitWarning`.
 * @param rest - the type/code/options arguments that followed it.
 * @returns the `Type: message` text.
 */
function warningLabel(warning: string | Error, rest: readonly unknown[]): string {
  const message = typeof warning === 'string' ? warning : warning.message
  const option = rest[0]
  let type = 'Warning'
  if (typeof option === 'string') {
    type = option
  }
  else if (option !== null && typeof option === 'object' && typeof (option as { type?: unknown }).type === 'string') {
    type = (option as { type: string }).type
  }
  else if (warning instanceof Error && warning.name !== 'Error') {
    type = warning.name
  }
  return type + ': ' + message
}

/**
 * Hold process warnings until {@link WarningGuard.restore} runs.
 * @param limit - most recent warnings to keep.
 * @returns the guard the caller releases when the terminal is restored.
 */
export function holdProcessWarnings(limit = HELD_WARNING_LIMIT): WarningGuard {
  const original = process.emitWarning
  const held: string[] = []
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    held.push(warningLabel(warning, rest))
    if (held.length > limit) held.shift()
  }) as unknown as typeof process.emitWarning
  return {
    restore: () => {
      process.emitWarning = original
      return held
    },
  }
}
