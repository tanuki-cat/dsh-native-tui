/**
 * Cancellation for the `/` command the terminal is running.
 *
 * One controller serves a whole dispatch: a handler may run commands through its
 * own context, and those nested calls belong to the same user-visible wait. The
 * controller outlives the outer call while they run, and is replaced once it has
 * been aborted so the next command starts un-cancelled.
 *
 * @module dsh-native-tui/ui/command-dispatch
 */

/** One dispatch, whose caller must release it when the command settles. */
export interface CommandDispatch {
  /** Cancellation of the whole dispatch, narrowed by the terminal's lifetime. */
  readonly signal: AbortSignal
  /** Whether the operator cancelled this dispatch, rather than the terminal shutting down. */
  cancelled(): boolean
  /** Mark one command of this dispatch as settled. */
  release(): void
}

/** Tracks the dispatch in flight so Escape can cancel it. */
export class CommandDispatchTracker {
  private current: { readonly controller: AbortController; count: number } | undefined

  /** @param lifetime - the terminal's own signal, so disposal also cancels a dispatch. */
  constructor(private readonly lifetime: AbortSignal) {}

  /** Whether a dispatch is still running; the shortcut map reads this per key. */
  get running(): boolean {
    return this.current !== undefined
  }

  /** Cancellation surface for a context built outside any dispatch. */
  signal(): AbortSignal {
    const dispatch = this.current
    return dispatch === undefined
      ? this.lifetime
      : AbortSignal.any([this.lifetime, dispatch.controller.signal])
  }

  /**
   * Track one dispatch, reusing the one in flight unless it was cancelled.
   * @returns the dispatch's cancellation surface and the release its caller owes in `finally`.
   */
  begin(): CommandDispatch {
    const dispatch = this.current !== undefined && !this.current.controller.signal.aborted
      ? this.current
      : { controller: new AbortController(), count: 0 }
    dispatch.count += 1
    this.current = dispatch
    return {
      signal: AbortSignal.any([this.lifetime, dispatch.controller.signal]),
      cancelled: () => dispatch.controller.signal.aborted,
      release: () => {
        dispatch.count -= 1
        if (dispatch.count === 0 && this.current === dispatch) this.current = undefined
      },
    }
  }

  /** Abort the dispatch in flight; false when nothing is running or it is already cancelled. */
  cancel(): boolean {
    const dispatch = this.current
    if (dispatch === undefined || dispatch.controller.signal.aborted) return false
    dispatch.controller.abort(new Error('native-tui: command cancelled'))
    return true
  }
}
