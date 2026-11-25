/**
 * Terminal tab status through the Program Status Protocol (OSC 7501).
 *
 * A tab that shows only the title cannot say whether this Session is working,
 * waiting on the operator, or finished. The protocol keeps one record per
 * program; the state is derived from Host events here and written only when it
 * changes, because the record is terminal-wide state, not a cell of a frame.
 *
 * @module dsh-native-tui/ui/tab-status
 */

import type { ProgramStatus } from '@earendil-works/pi-tui'

/** Stable program identifier terminals group records, icons and filters by. */
export const TAB_STATUS_APP = 'dsh'

export type TabBlockedKind = 'permission' | 'question'

/** What the terminal tab should report the program is doing. */
export type TabActivity =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working' }
  | { readonly phase: 'blocked'; readonly kind: TabBlockedKind }
  | { readonly phase: 'done' }
  | { readonly phase: 'error' }

/** A settled turn whose outcome holds until the next turn starts. */
export type TabOutcome = 'done' | 'error'

/** The Session facts the tab record is derived from. */
export interface TabStateInput {
  /** Whether a turn is executing. */
  readonly running: boolean
  /** Dialog waiting for the operator, when one is open. */
  readonly blocked?: TabBlockedKind
  /** Outcome of the last settled turn; absent until one settles. */
  readonly outcome?: TabOutcome
}

/**
 * Derive the tab record from the Session state.
 *
 * A dialog outranks the Agent's own activity: a turn waiting for an approval is
 * blocked, not working. A settled outcome holds until the next turn starts.
 * @param input - current Session facts.
 * @returns what the tab should report.
 */
export function tabActivity(input: TabStateInput): TabActivity {
  if (input.blocked !== undefined) return { phase: 'blocked', kind: input.blocked }
  if (input.running) return { phase: 'working' }
  return input.outcome === 'done' ? { phase: 'done' }
    : input.outcome === 'error' ? { phase: 'error' }
      : { phase: 'idle' }
}

/** Track the topmost blocking dialog even when an older one closes first. */
export class TabBlockingDialogs {
  private readonly dialogs: Array<{ readonly kind: TabBlockedKind }> = []

  get current(): TabBlockedKind | undefined {
    return this.dialogs.at(-1)?.kind
  }

  open(kind: TabBlockedKind): () => void {
    const dialog = { kind }
    this.dialogs.push(dialog)
    return () => {
      const index = this.dialogs.indexOf(dialog)
      if (index !== -1) this.dialogs.splice(index, 1)
    }
  }

  clear(): void {
    this.dialogs.length = 0
  }
}

/**
 * Encode one activity as the protocol's single root record.
 *
 * Every report replaces the previous record wholesale, so `app` travels with
 * each state; `kind` and its reason are only meaningful while blocked.
 * @param activity - current state of the program.
 * @returns the record to hand to the terminal.
 */
export function tabProgramStatus(activity: TabActivity): ProgramStatus {
  switch (activity.phase) {
    case 'blocked':
      return {
        state: 'blocked',
        app: TAB_STATUS_APP,
        kind: activity.kind,
        message: 'waiting:' + activity.kind,
      }
    case 'working':
      return { state: 'working', app: TAB_STATUS_APP }
    case 'done':
      return { state: 'done', app: TAB_STATUS_APP }
    case 'error':
      return { state: 'error', app: TAB_STATUS_APP, message: 'Turn failed' }
    case 'idle':
      return { state: 'idle', app: TAB_STATUS_APP }
  }
}

/** The terminal write the reporter needs, narrower than pi-tui's Terminal. */
export interface TabStatusTerminal {
  /** Report one program-status record. */
  setProgramStatus(status: ProgramStatus): void
}

/**
 * Write the tab record only when it changes.
 *
 * The status block repaints on every Session event; repeating OSC 7501 there
 * would rewrite terminal state for a record that did not move.
 */
export class TabStatusReporter {
  /** Comparable form of the record last written. */
  private last: string | undefined

  /** @param terminal - terminal that owns the record. */
  constructor(private readonly terminal: TabStatusTerminal) {}

  /**
   * Report one activity.
   * @param activity - current state of the program.
   * @returns whether this call wrote a sequence.
   */
  report(activity: TabActivity): boolean {
    const status = tabProgramStatus(activity)
    const key = status.state + '\u0000' + (status.kind ?? '') + '\u0000' + (status.message ?? '')
    if (key === this.last) return false
    this.last = key
    this.terminal.setProgramStatus(status)
    return true
  }
}
