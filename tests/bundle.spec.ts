import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unzipSync } from 'fflate'
import { exportSessionBundle, type BundleAttachmentsService } from '../src/runtime/bundle.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeAgent(cwd: string): Agent {
  return {
    session: {
      header: { id: 'session-1', cwd, createdAt: 1 },
      snapshotEvents: () => [
        {
          type: 'user/message',
          seq: 0,
          time: 1,
          data: {
            content: [
              { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', name: 'pixel.png', bytes: 3 } },
              { type: 'file', attachment: { attachmentId: 'file-1', name: 'note.txt', bytes: 5 } },
            ],
          },
        },
        { type: 'deliverables/presented', seq: 1, time: 2, data: { turn: 1, files: [{ path: 'out.md' }] } },
      ],
    },
  } as unknown as Agent
}

const attachments: BundleAttachmentsService = {
  readImage: async () => ({ data: Uint8Array.from([1, 2, 3]) }),
  readFileStream: async function* () { yield new TextEncoder().encode('hello') },
}

describe('exportSessionBundle', () => {
  it('writes session, manifest, attachments, and deliverables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'out.md'), '# deliverable\n')
    const result = await exportSessionBundle(fakeAgent(dir), 'bundle.zip', dir, attachments)
    expect(result.attachments).toHaveLength(2)
    expect(result.deliverables).toHaveLength(1)
    expect(result.skipped).toEqual([])
    const archive = unzipSync(await readFile(join(dir, 'bundle.zip')))
    expect(Object.keys(archive)).toEqual(expect.arrayContaining([
      'session.jsonl', 'manifest.json', 'README.txt',
      expect.stringContaining('attachments/img-1-pixel.png'),
      expect.stringContaining('attachments/file-1-note.txt'),
      expect.stringContaining('deliverables/1-out.md'),
    ]))
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])) as {
      id: string
      eventCount: number
      attachments: unknown[]
      deliverables: unknown[]
    }
    expect(manifest.id).toBe('session-1')
    expect(manifest.eventCount).toBe(2)
    expect(manifest.attachments).toHaveLength(2)
    expect(manifest.deliverables).toHaveLength(1)
  })

  it('records unreadable attachments instead of failing the bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'out.md'), '# deliverable\n')
    const failing: BundleAttachmentsService = {
      readImage: async () => { throw new Error('gone') },
      readFileStream: async function* () { throw new Error('gone') },
    }
    const result = await exportSessionBundle(fakeAgent(dir), 'bundle.zip', dir, failing)
    expect(result.attachments).toHaveLength(0)
    expect(result.skipped).toHaveLength(2)
    const archive = unzipSync(await readFile(join(dir, 'bundle.zip')))
    expect(archive['session.jsonl']).toBeDefined()
  })
})