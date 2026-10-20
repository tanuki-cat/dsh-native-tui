/**
 * Argument rewriting for an in-place TUI reload.
 *
 * @module dsh-native-tui/runtime/reload
 */

/**
 * Build the launcher arguments for a fresh process that resumes the Session on
 * screen. Existing app-level `--resume` flags are removed because the TUI's
 * parser takes the last one; every other launcher flag (profile, patches, and
 * passthrough arguments) is preserved.
 * @param argv - arguments after the node executable and bin script.
 * @param sessionId - Session to resume in the replacement process.
 * @returns arguments for the new process.
 */
export function reloadArgs(argv: readonly string[], sessionId: string): string[] {
  const args: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--resume') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) index += 1
      continue
    }
    if (arg.startsWith('--resume=')) continue
    args.push(arg)
  }
  args.push('--resume', sessionId)
  return args
}
