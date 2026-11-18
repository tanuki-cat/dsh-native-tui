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

/**
 * How long a handoff stays valid.
 *
 * A replacement that fails to mount can be retried moments later and must still
 * find the Session on screen. A plugin that is re-enabled hours afterwards must
 * not silently reopen a conversation the operator has long left — that is a new
 * launch, and it belongs on whatever Session it asks for.
 */
export const RELOAD_SESSION_TTL_MS = 60_000

/** The Session a replacement must reopen; the symbol slot survives module replacement. */
interface ReloadSessionSlot {
  sessionId?: string
  /** Wall clock of the handoff, so a stale claim can be refused. */
  handedOffAt?: number
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
 * @param now - clock the handoff is stamped with, injectable for tests.
 */
export function rememberReloadSession(sessionId: string, now = Date.now()): void {
  const slot = reloadSessionSlot()
  slot.sessionId = sessionId
  slot.handedOffAt = now
}

/**
 * Read the Session a replacement must reopen, without consuming it.
 *
 * A handoff older than {@link RELOAD_SESSION_TTL_MS} is discarded instead of
 * returned: the plugin may be enabled again long after the replacement died, and
 * that launch must not resume a Session nobody asked for.
 * @param maxAgeMs - how long a handoff may stand.
 * @param now - clock the handoff age is measured with, injectable for tests.
 * @returns the remembered Session id, or undefined when none is pending.
 */
export function peekReloadSession(maxAgeMs = RELOAD_SESSION_TTL_MS, now = Date.now()): string | undefined {
  const slot = reloadSessionSlot()
  if (slot.sessionId === undefined) return undefined
  if (slot.handedOffAt !== undefined && now - slot.handedOffAt > maxAgeMs) {
    clearReloadSession()
    return undefined
  }
  return slot.sessionId
}

/** Drop the remembered Session once a replacement has opened it. */
export function clearReloadSession(): void {
  const slot = reloadSessionSlot()
  delete slot.sessionId
  delete slot.handedOffAt
}
