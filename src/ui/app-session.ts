/**
 * Session handover and input gating for the terminal application.
 *
 * Switching Sessions is the one operation that must stop drawing, cancel
 * dialogs, and release a Host Agent while a replacement is being opened. The
 * rules live here so they can be exercised without a terminal: which handle
 * owns the screen after a failure, and when a key may still reach a dialog.
 *
 * @module dsh-native-tui/ui/app-session
 */

import type { GlobalShortcut } from './keymap.js'

/** Outcome of handing the screen from one Session to another. */
export type SessionHandoverResult<T> =
  | { readonly status: 'switched'; readonly session: T }
  | { readonly status: 'same'; readonly session: T }
  | { readonly status: 'aborted'; readonly unopened?: T }
  | {
    readonly status: 'failed'
    readonly error: unknown
    /** Whether the outgoing Session is still alive and has been re-attached. */
    readonly restorable: boolean
    /** Replacement opened but never adopted; the caller must release it. */
    readonly unopened?: T
  }

/** Collaborators a Session handover drives. */
export interface SessionHandover<T> {
  /** Session currently on screen. */
  readonly current: T
  /** Open the replacement. Called once. */
  readonly open: () => Promise<T>
  /** Release one Session; used for the outgoing and for an unadopted replacement. */
  readonly release: (session: T) => Promise<void>
  /** The opener releases `current` itself (a restart), so stop drawing it first. */
  readonly closedByOpener?: boolean
  /** Reports whether an opener with `closedByOpener` actually disposed `current` before failing. */
  readonly previousClosed?: () => boolean
  /** Stop drawing the outgoing Session: subscriptions, dialogs, and timers. */
  readonly detach: () => void
  /** Re-bind the outgoing Session after a handover that could not complete. */
  readonly attach: () => void
  /** Put the replacement on screen. */
  readonly adopt: (next: T) => void
  /** Whether the application was disposed while the replacement opened. */
  readonly aborted?: () => boolean
}

/**
 * Move the terminal from one Session to another.
 *
 * The outgoing Session keeps the screen until its Agent is released: a failed
 * open or a failed release re-attaches its subscriptions, so the UI is never
 * left disconnected from a handle that is still alive. A restart is the one
 * path that cannot roll back because the opener disposes the old Agent itself;
 * there a failure reports no restorable handle and the caller must treat the
 * Session as lost until the process reloads.
 * @param handover - the sessions and the operations that move between them.
 * @returns what happened, including any opened replacement the caller owns.
 */
export async function handOverSession<T>(handover: SessionHandover<T>): Promise<SessionHandoverResult<T>> {
  const previous = handover.current
  let opened: T | undefined
  let detached = false
  let adopted = false
  let previousClosed = false
  const hasClosedPrevious = (): boolean => previousClosed || (handover.closedByOpener === true && (handover.previousClosed?.() ?? true))

  const detach = (): void => {
    if (detached) return
    detached = true
    handover.detach()
  }
  const attach = (): void => {
    if (!detached) return
    detached = false
    handover.attach()
  }
  const abortedResult = (): SessionHandoverResult<T> => opened === undefined
    ? { status: 'aborted' }
    : { status: 'aborted', unopened: opened }
  const failedResult = (error: unknown, restorable: boolean): SessionHandoverResult<T> => ({
    status: 'failed',
    error,
    restorable,
    ...(opened === undefined || adopted ? {} : { unopened: opened }),
  })

  try {
    // A restart releases the old Agent inside `open`; nothing may stay bound
    // to it while that happens.
    if (handover.closedByOpener === true) detach()
    opened = await handover.open()
    if (opened === previous) {
      attach()
      return { status: 'same', session: opened }
    }
    if (handover.aborted?.() === true) return abortedResult()
    detach()
    if (!hasClosedPrevious()) {
      try {
        await handover.release(previous)
        previousClosed = true
      }
      catch (error) {
        // The Host could not release the old Agent, so it still owns the
        // screen; re-bind it instead of leaving the terminal orphaned.
        attach()
        return failedResult(error, true)
      }
    }
    if (handover.aborted?.() === true) return abortedResult()
    handover.adopt(opened)
    adopted = true
    return { status: 'switched', session: opened }
  }
  catch (error) {
    // `open` failed. The outgoing Session keeps ownership unless this handover
    // already released it (or the opener actually disposed it during a restart).
    const closed = hasClosedPrevious()
    if (!closed) attach()
    return failedResult(error, !closed)
  }
}

/** What the terminal does with one global shortcut before the focused component sees it. */
export type ShortcutDisposition = 'handle' | 'defer' | 'swallow'

/** Terminal state that decides whether a shortcut must wait. */
export interface ShortcutGate {
  /** Whether a Session switch is in flight. */
  readonly switching: boolean
  /** Whether an asynchronous paste drain is in flight. */
  readonly processingPaste: boolean
}

/**
 * Gate global shortcuts during an asynchronous paste or a Session switch.
 *
 * A key with no shortcut must reach the focused component even mid-switch: that
 * is how an open dialog receives Escape, and swallowing it would leave the
 * dialog (and the switch waiting on it) stuck. Exit and turn cancellation stay
 * live because they are how the operator escapes a stuck screen.
 * @param shortcut - shortcut the key maps to, when it maps to one.
 * @param gate - busy states of the terminal.
 * @returns whether to handle the key, defer and replay it after the paste, or swallow it.
 */
export function shortcutDisposition(shortcut: GlobalShortcut | undefined, gate: ShortcutGate): ShortcutDisposition {
  if (shortcut === undefined) return 'handle'
  const urgent = shortcut === 'exit' || shortcut === 'cancel-turn'
  if (gate.processingPaste && !urgent) return 'defer'
  if (gate.switching && !urgent) return 'swallow'
  return 'handle'
}

/** Overlay surface a switch closes; narrowed so its policy needs no terminal. */
export interface OverlaySurface {
  hasOverlay(): boolean
  hideOverlay(): void
}

/**
 * Cancel the dialogs of the Session leaving the screen.
 *
 * An approval or question holds the outgoing Agent's request open; answering it
 * after the switch would write back to an Agent that is already gone. The
 * controller cannot be reused after aborting, so a fresh scope is returned for
 * the Session now on screen.
 * @param scope - cancellation bound to the outgoing Session.
 * @param tui - terminal surface that owns the open overlay.
 * @returns the cancellation scope for the incoming Session.
 */
export function resetInteractionScope(scope: AbortController, tui: OverlaySurface): AbortController {
  scope.abort(new Error('native-tui: session changed'))
  if (tui.hasOverlay()) tui.hideOverlay()
  return new AbortController()
}

/** Terminal operations one global shortcut dispatches to. */
export interface GlobalShortcutActions {
  /** Whether a dialog currently owns the keyboard. */
  readonly overlayOpen: () => boolean
  readonly newSession: () => void
  readonly pickSession: () => void
  readonly cycleReasoning: () => void
  readonly toggleToolPreviews: () => void
  readonly jumpToLatest: () => void
  readonly clearInput: () => void
  /** Cancel the `/` dispatch in flight; false when nothing is running. */
  readonly cancelCommand: () => boolean
  readonly cancelTurn: () => void
  readonly exit: () => void
}

/**
 * Run one global shortcut.
 *
 * A dialog keeps Escape for itself, so shortcuts that would act behind it
 * decline instead of consuming the key. The switch is exhaustive: a new
 * shortcut cannot silently fall through to the exit path.
 * @param shortcut - shortcut the key maps to.
 * @param actions - terminal operations the shortcut names.
 * @returns whether the terminal consumed the key, or undefined to let the focused component see it.
 */
export function runGlobalShortcut(
  shortcut: GlobalShortcut,
  actions: GlobalShortcutActions,
): { consume: true } | undefined {
  switch (shortcut) {
    case 'new-session': {
      if (actions.overlayOpen()) return undefined
      actions.newSession()
      return { consume: true }
    }
    case 'pick-session': {
      if (actions.overlayOpen()) return undefined
      actions.pickSession()
      return { consume: true }
    }
    case 'cycle-reasoning': {
      if (actions.overlayOpen()) return undefined
      actions.cycleReasoning()
      return { consume: true }
    }
    case 'toggle-tool-previews': {
      if (actions.overlayOpen()) return undefined
      actions.toggleToolPreviews()
      return { consume: true }
    }
    case 'jump-to-latest': {
      actions.jumpToLatest()
      return { consume: true }
    }
    case 'clear-input': {
      actions.clearInput()
      return { consume: true }
    }
    case 'cancel-command': {
      if (actions.overlayOpen()) return undefined
      return actions.cancelCommand() ? { consume: true } : undefined
    }
    case 'cancel-turn': {
      if (actions.overlayOpen()) return undefined
      actions.cancelTurn()
      return { consume: true }
    }
    case 'exit': {
      actions.exit()
      return { consume: true }
    }
    default: {
      const unhandled: never = shortcut
      return unhandled
    }
  }
}
