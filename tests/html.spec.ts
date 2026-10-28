import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { exportSessionHtml } from '../src/runtime/html.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeAgent(cwd: string): Agent {
  const callId = ToolCallId('c1')
  const events: SessionEvent[] = [
    { type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '<script>alert(1)</script>' }] }) },
    { type: 'assistant/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'hello & goodbye' }] }),
    } },
    { type: 'tool/call', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1, callId, name: 'read', arguments: '{"path":"a.ts"}' } },
    { type: 'tool/result', seq: SessionSeq(3), time: 4, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'file body' }], isError: false }),
    } },
  ]
  return { session: { header: { id: 'session-html', cwd, createdAt: 1 }, snapshotEvents: () => events } } as unknown as Agent
}

describe('exportSessionHtml', () => {
  it('escapes message text and includes tool cards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-html-'))
    cleanup.push(dir)
    const result = await exportSessionHtml(fakeAgent(dir), 'session.html', dir)
    const html = await readFile(join(dir, 'session.html'), 'utf8')
    expect(result.eventCount).toBe(4)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('hello &amp; goodbye')
    expect(html).toContain('Tool · read')
    expect(html).toContain('file body')
  })
})
