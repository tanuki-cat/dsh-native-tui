import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { exportSessionHtml } from '../src/runtime/html.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeAgent(cwd: string): Agent {
  return {
    session: {
      header: { id: 'session-html', cwd, createdAt: 1 },
      snapshotEvents: () => [
        { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<script>alert(1)</script>' }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hello & goodbye' }] } },
        { type: 'tool/call', seq: 2, time: 3, data: { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
        { type: 'tool/result', seq: 3, time: 4, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'file body' }], isError: false } } },
      ],
    },
  } as unknown as Agent
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
