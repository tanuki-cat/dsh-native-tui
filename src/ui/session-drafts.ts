import { resolve } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingAttachment } from '../runtime/attachments.js'
import { sessionAgentPreset } from '../runtime/agent.js'

/** An unsent prompt, held only for the lifetime of this terminal. */
export interface SessionDraft {
  readonly text: string
  readonly attachments: PendingAttachment[]
}

interface DraftEntry {
  readonly draft: SessionDraft
  readonly cwd: string
  readonly preset: string | undefined
  readonly started: boolean
}

/** Per-session drafts and blank-session candidates visited by this terminal. */
export class SessionDrafts {
  private readonly entries = new Map<SessionId, DraftEntry>()

  save(session: Session, draft: SessionDraft, cwd: string, preset?: string): void {
    const previous = this.entries.get(session.id)
    const started = previous?.started === true || session.snapshotEvents().some(event =>
      event.type === 'turn/start' || event.type === 'user/message'
      || event.type === 'assistant/message' || event.type === 'assistant/attempt')
    this.entries.set(session.id, {
      draft, cwd: resolve(session.header.cwd ?? cwd),
      preset: sessionAgentPreset(session) ?? preset, started,
    })
  }

  restore(id: SessionId): SessionDraft {
    return this.entries.get(id)?.draft ?? { text: '', attachments: [] }
  }

  findBlank(cwd: string, preset: string | undefined, archived: readonly string[] = []): SessionId | undefined {
    const path = resolve(cwd)
    for (const [id, entry] of this.entries) {
      if (!entry.started && entry.cwd === path && entry.preset === preset && !archived.includes(id)) return id
    }
    return undefined
  }
}
