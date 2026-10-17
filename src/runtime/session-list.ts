/**
 * Session-id prefix this terminal stamps on every root session it creates, so a
 * shared store can tell its own sessions apart from those of other front doors.
 */
export const NATIVE_TUI_SESSION_ID_PREFIX = 'native-tui-'

/** Whether `id` names a root session created by this terminal. */
export function isNativeTuiSessionId(id: string): boolean {
  return id.startsWith(NATIVE_TUI_SESSION_ID_PREFIX)
}

/** One stored session, reduced to what a bounded listing needs. */
export interface ListedSession {
  readonly id: string
  readonly cwd?: string
  readonly createdAt: number
}

/** The sessions a bounded listing shows, plus how many were omitted. */
export interface ListedSessionSelection<T extends ListedSession> {
  readonly shown: readonly T[]
  readonly hidden: number
}

/**
 * Choose the sessions a bounded listing shows. Persistence promises no order,
 * so the newest sessions are ordered explicitly and the active session is
 * pinned first: truncating a listing must never hide the session the caller is
 * already in.
 * @param rows - every stored session the caller may show.
 * @param currentId - the active session id, pinned first when it is present.
 * @param limit - maximum sessions to show.
 * @returns the shown rows in display order and the count of omitted sessions.
 */
export function selectListedSessions<T extends ListedSession>(
  rows: readonly T[],
  currentId: string,
  limit: number,
): ListedSessionSelection<T> {
  const newestFirst = [...rows].sort((left, right) => right.createdAt - left.createdAt)
  const current = newestFirst.filter(row => row.id === currentId)
  const others = newestFirst.filter(row => row.id !== currentId)
  const shown = [...current, ...others].slice(0, Math.max(0, limit))
  return { shown, hidden: rows.length - shown.length }
}

/** A stored session plus the header field that classifies its origin. */
export interface StoredSession extends ListedSession {
  readonly origin?: string
}

/**
 * Keep only the sessions this terminal owns. Delegated subagent children and
 * root sessions created by another front door (for example the web profile)
 * share the same store, so a listing that shows every stored row mixes in
 * conversations the caller never started here.
 * @param rows - every stored session the caller may show.
 * @returns the owned rows, in their original order.
 */
export function ownStoredSessions<T extends StoredSession>(rows: readonly T[]): T[] {
  return rows.filter(row => row.origin !== 'subagent' && isNativeTuiSessionId(row.id))
}
