/**
 * Argument and environment handoff for an in-place TUI reload.
 *
 * The launcher re-parses its own flags, so the replacement process has two
 * independent carriers for the Session it must resume: the `--resume` flag and
 * the environment variable this module names. The flag is the documented
 * surface; the variable is what keeps the resume request intact if the flag is
 * lost between the two process images.
 *
 * @module dsh-native-tui/runtime/reload
 */

/** Environment variable one replacement process inherits with its Session id. */
export const RESUME_ENV = 'DSH_NATIVE_TUI_RESUME'

/** Shape a Session id may carry before it is handed to a process argument. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/

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

/**
 * Read the Session id one replacement process exported.
 *
 * A value outside the id shape is ignored rather than trusted: the variable is
 * inherited from the terminal's environment, so a stale or hand-edited value
 * must not silently redirect the next launch.
 * @param value - raw environment value, if set.
 * @returns the Session id, or undefined when the value is absent or unusable.
 */
export function resumeIdFromEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * Refuse a resume that landed on another Session.
 *
 * The terminal owns one Agent for one Session; a Host that answered a resume
 * with a different identity would leave the operator looking at a conversation
 * that is not the one they reloaded.
 * @param requested - Session id the launch asked for, when it asked for one.
 * @param actual - Session id the Host opened.
 * @throws when the two identities differ.
 */
export function assertResumed(requested: string | undefined, actual: string): void {
  if (requested === undefined || requested === actual) return
  throw new Error('native-tui: the Host resumed session ' + actual + ' instead of the requested ' + requested)
}

/** Process-global slot an in-place plugin replacement reads back. */
const RELOAD_SESSION = Symbol.for('dsh-native-tui.reload-session')

/** The Session a replacement must reopen; the symbol slot survives module replacement. */
interface ReloadSessionSlot {
  sessionId?: string
}

function reloadSessionSlot(): ReloadSessionSlot {
  const holder = globalThis as typeof globalThis & { [key: symbol]: ReloadSessionSlot | undefined }
  return (holder[RELOAD_SESSION] ??= {})
}

/**
 * Remember the Session an in-process plugin replacement must reopen.
 *
 * HMR can replace this plugin while the terminal owns a live Session. The
 * replacement runs `apply()` again with the original configuration, so without
 * a handoff it would open a new Session and clear the conversation on screen.
 * The slot lives on `globalThis` because the replacement is a new module
 * instance in the same process.
 * @param sessionId - Session currently displayed by the terminal.
 */
export function rememberReloadSession(sessionId: string): void {
  reloadSessionSlot().sessionId = sessionId
}

/**
 * Read the Session a replacement must reopen, without consuming it.
 * @returns the remembered Session id, or undefined when none is pending.
 */
export function peekReloadSession(): string | undefined {
  return reloadSessionSlot().sessionId
}

/** Drop the remembered Session once a replacement has opened it. */
export function clearReloadSession(): void {
  delete reloadSessionSlot().sessionId
}
