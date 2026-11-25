import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Result of one terminal-native Session log export. */
export interface SessionExportResult {
  readonly path: string
  readonly eventCount: number
}

/**
 * Write the current Session header metadata and durable event log as JSONL.
 * This is a terminal-side export, not the Web ZIP/attachment archive.
 * @param agent - active Agent whose durable log is exported.
 * @param target - relative path resolved from cwd, or an absolute path.
 * @param cwd - Session workspace root used for relative targets.
 * @param signal - cancels generation and the write when the command is aborted.
 * @returns written path and event count.
 */
export async function exportSessionLog(
  agent: Agent,
  target: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SessionExportResult> {
  signal?.throwIfAborted()
  const path = resolve(cwd, target)
  const session = agent.session
  const events = session.snapshotEvents()
  const header = {
    kind: 'native-tui-session-export',
    version: 1,
    id: session.header.id,
    cwd: session.header.cwd,
    createdAt: session.header.createdAt,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
  }
  const lines = [JSON.stringify(header)]
  for (const event of events) {
    signal?.throwIfAborted()
    lines.push(JSON.stringify(event))
  }
  signal?.throwIfAborted()
  // A session log can quote prompts and tool output; keep the file private.
  await writeFile(path, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { path, eventCount: events.length }
}
