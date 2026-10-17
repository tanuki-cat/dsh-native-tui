import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { exportSessionLog } from '../src/runtime/export.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function agent(): Agent {
  return {
    session: {
      header: { id: 'session-1', cwd: '/tmp/workspace', createdAt: 123 },
      snapshotEvents: () => [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    },
  } as unknown as Agent
}

describe('exportSessionLog', () => {
  it('writes a header and every durable event as JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-export-'))
    cleanup.push(dir)
    const result = await exportSessionLog(agent(), 'session.jsonl', dir)
    expect(result).toEqual({ path: join(dir, 'session.jsonl'), eventCount: 2 })
    const lines = (await readFile(result.path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'native-tui-session-export',
      version: 1,
      id: 'session-1',
      eventCount: 2,
    })
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'turn/start', seq: 0 })
    expect(JSON.parse(lines[2]!)).toMatchObject({ type: 'turn/end', seq: 1 })
  })

  it('refuses to overwrite an existing export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-export-'))
    cleanup.push(dir)
    await exportSessionLog(agent(), 'session.jsonl', dir)
    await expect(exportSessionLog(agent(), 'session.jsonl', dir)).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
