import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

/** Read the committed workspace of a live session. */
export function currentWorkingDirectory(host: Context, session: Session, fallback: string): string {
  const service = host.get('workingDirectory') as { get(session: Session): string } | undefined
  return service === undefined ? session.header.cwd ?? fallback : service.get(session)
}
