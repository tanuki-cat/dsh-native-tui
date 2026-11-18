import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { unzipSync } from 'fflate'
import {
  exportSessionBundle,
  MAX_BUNDLE_DELIVERABLE_BYTES,
  MAX_BUNDLE_DELIVERABLE_TOTAL_BYTES,
  type BundleAttachmentsService,
} from '../src/runtime/bundle.js'

type AttachmentId = Extract<ContentBlock, { type: 'image' }>['attachment']['attachmentId']

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

/** An Agent whose only content is the deliverables it presented. */
function presentingAgent(cwd: string, paths: readonly string[]): Agent {
  return {
    session: {
      header: { id: 'deliverables', cwd, createdAt: 1 },
      snapshotEvents: () => [{
        type: 'deliverables/presented', seq: 0, time: 1,
        data: { turn: 1, files: paths.map(path => ({ path })) },
      }],
    },
  } as unknown as Agent
}

const attachments: BundleAttachmentsService = {
  readImage: async () => ({ data: Uint8Array.from([1, 2, 3]) }),
  readFileStream: async function* () { yield new TextEncoder().encode('hello') },
}

describe('exportSessionBundle', () => {
  it.each(['assistant/message', 'tool/result'] as const)('includes and deduplicates attachments in %s message.content', async type => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(dir)
    const content: ContentBlock[] = [
      { type: 'image', attachment: { attachmentId: 'nested-image' as AttachmentId, mediaType: 'image/png', name: 'nested.png', bytes: 3, width: 1, height: 1 } },
      { type: 'file', attachment: { attachmentId: 'nested-file' as AttachmentId, name: 'nested.txt', bytes: 5 } },
    ]
    const nested: SessionEvent = type === 'assistant/message'
      ? { type, seq: SessionSeq(0), time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [],
        message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content }) } }
      : { type, seq: SessionSeq(0), time: 1, surfaceOp: 'append', data: { turn: 1, step: 1,
        message: createToolResultMessage({ callId: ToolCallId('c1'), content, isError: false }) } }
    const duplicate: SessionEvent = { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user' }, content: [content[0]!] }) }
    const events: SessionEvent[] = [nested, duplicate]
    const agent = { session: { header: { id: 'nested', cwd: dir, createdAt: 1 }, snapshotEvents: () => events } } as unknown as Agent
    const reads: string[] = []
    const service: BundleAttachmentsService = {
      readImage: async ref => { reads.push(ref.attachmentId); return { data: Uint8Array.of(1, 2, 3) } },
      readFileStream: async function* (ref) { reads.push(ref.attachmentId); yield new TextEncoder().encode('hello') },
    }
    const result = await exportSessionBundle(agent, 'bundle.zip', dir, service)
    expect(result.attachments).toHaveLength(2)
    expect(reads.sort()).toEqual(['nested-file', 'nested-image'])
    const zip = unzipSync(await readFile(result.path))
    expect(zip['attachments/nested-image-nested.png']).toEqual(Uint8Array.of(1, 2, 3))
    expect(new TextDecoder().decode(zip['attachments/nested-file-nested.txt'])).toBe('hello')
    expect(JSON.parse(new TextDecoder().decode(zip['manifest.json'])).attachments).toEqual(result.attachments)
  })

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

  it('bounds the bytes every presented deliverable may add', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(dir)
    // Three files at the per-file cap: the first two fill the aggregate budget
    // and the third has to be skipped instead of doubling the archive.
    const names = ['one.bin', 'two.bin', 'three.bin']
    for (const [index, name] of names.entries()) {
      const path = join(dir, name)
      await writeFile(path, '')
      await truncate(path, index === names.length - 1 ? 1 : MAX_BUNDLE_DELIVERABLE_BYTES)
    }
    const agent = {
      session: {
        header: { id: 'budget', cwd: dir, createdAt: 1 },
        snapshotEvents: () => [{
          type: 'deliverables/presented', seq: 0, time: 1,
          data: { turn: 1, files: names.map(name => ({ path: name })) },
        }],
      },
    } as unknown as Agent
    const result = await exportSessionBundle(agent, 'bundle.zip', dir, attachments)
    expect(result.deliverables.map(record => record.path)).toEqual(['one.bin', 'two.bin'])
    expect(result.skipped).toEqual(['deliverable three.bin: bundle deliverable limit reached'])
    expect(result.deliverables.reduce((sum, record) => sum + record.bytes, 0))
      .toBe(MAX_BUNDLE_DELIVERABLE_TOTAL_BYTES)
    const archive = unzipSync(await readFile(result.path))
    expect(Object.keys(archive).some(entry => entry.includes('three.bin'))).toBe(false)
  })

  it('skips a presented path outside the session workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(parent)
    const dir = join(parent, 'workspace')
    await mkdir(dir)
    await writeFile(join(parent, 'secret.md'), 'outside\n')
    const agent = {
      session: {
        header: { id: 'escape', cwd: dir, createdAt: 1 },
        snapshotEvents: () => [{
          type: 'deliverables/presented', seq: 0, time: 1,
          data: { turn: 1, files: [{ path: '../secret.md' }] },
        }],
      },
    } as unknown as Agent
    const result = await exportSessionBundle(agent, 'bundle.zip', dir, attachments)
    expect(result.deliverables).toHaveLength(0)
    expect(result.skipped).toEqual(['deliverable ../secret.md: outside the session workspace'])
    const archive = unzipSync(await readFile(result.path))
    expect(Object.keys(archive).some(entry => entry.includes('secret'))).toBe(false)
  })

  it('keeps a deliverable whose name merely starts with dots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(dir)
    await writeFile(join(dir, '..notes.md'), 'notes\n')
    const result = await exportSessionBundle(presentingAgent(dir, ['..notes.md']), 'bundle.zip', dir, attachments)
    expect(result.deliverables.map(record => record.path)).toEqual(['..notes.md'])
    expect(result.skipped).toEqual([])
  })

  const withSymlinks = process.platform === 'win32' ? it.skip : it
  withSymlinks('follows a presented link before trusting the workspace boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'native-tui-bundle-'))
    cleanup.push(parent)
    const dir = join(parent, 'workspace')
    await mkdir(dir)
    await writeFile(join(parent, 'secret.md'), 'outside\n')
    await writeFile(join(dir, 'real.md'), 'inside\n')
    await symlink(join(parent, 'secret.md'), join(dir, 'escape.md'))
    await symlink(join(dir, 'real.md'), join(dir, 'inside.md'))
    const result = await exportSessionBundle(presentingAgent(dir, ['escape.md', 'inside.md']), 'bundle.zip', dir, attachments)
    expect(result.deliverables.map(record => record.path)).toEqual(['inside.md'])
    expect(result.skipped).toEqual(['deliverable escape.md: outside the session workspace'])
    const archive = unzipSync(await readFile(result.path))
    expect(Object.keys(archive).some(entry => entry.includes('inside'))).toBe(true)
    expect(Object.keys(archive).some(entry => entry.includes('escape'))).toBe(false)
  })
})