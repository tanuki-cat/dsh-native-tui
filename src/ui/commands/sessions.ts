/**
 * `/sessions`: the stored-session list notice.
 *
 * The switch itself stays in `app.ts`, because it owns the live session, the
 * transcript and the subscriptions the switch has to tear down and rebuild.
 *
 * @module dsh-native-tui/ui/commands/sessions
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ownStoredSessions, selectListedSessions } from '../../runtime/session-list.js'
import { formatLocalTimestamp } from '../format-time.js'
import type { CommandContext } from './context.js'
import { NL, errorMessage } from './shared.js'

/** How many stored sessions one notice lists. */
export const MAX_LISTED_SESSIONS = 12

/** The persisted-session service, narrowed to what the list needs. */
interface SessionPersistence {
  list(): Promise<readonly { header: { id: SessionId; cwd?: string; createdAt: number; origin?: string } }[]>
}

/** The `/sessions` command. */
export async function sessionsCommand(ctx: CommandContext): Promise<void> {
  const persistence = ctx.host.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) {
    ctx.notice('warning', 'Session persistence is unavailable; only the current session can be used.')
    return
  }
  try {
    const all = (await persistence.list()).map(row => row.header)
    const stored = ownStoredSessions(all)
    if (stored.length === 0) {
      ctx.notice('info', all.length === 0
        ? 'No stored sessions yet. Use /new to create one.'
        : 'No sessions created by this terminal yet. Use /new to create one.')
      return
    }
    const selection = selectListedSessions(stored, ctx.active.id, MAX_LISTED_SESSIONS)
    const lines = selection.shown.map(row => {
      const marker = row.id === ctx.active.id ? '*' : ' '
      return marker + ' ' + row.id + '  ' + (row.cwd ?? '') + '  ' + formatLocalTimestamp(row.createdAt)
    })
    const heading = selection.hidden === 0
      ? 'Sessions:'
      : 'Sessions (' + String(selection.shown.length) + ' of ' + String(stored.length) + ', newest first; '
        + String(selection.hidden) + ' older hidden):'
    ctx.notice('info', heading + NL + lines.join(NL) + NL + 'Use /resume <session-id> to switch.')
  }
  catch (error) {
    ctx.notice('error', 'Could not list sessions: ' + errorMessage(error))
  }
}
