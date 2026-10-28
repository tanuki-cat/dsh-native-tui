import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { attachCommand } from '../src/ui/commands/attachments.js'
import { deliverablesCommand, filesCommand } from '../src/ui/commands/artifacts.js'
import { exportCommand, openCommand, previewCommand } from '../src/ui/commands/workspace-files.js'
import { showChoice, showImagePreview } from '../src/ui/dialogs.js'
import { revealWithSystemApp } from '../src/runtime/open.js'
import { createPalette } from '../src/ui/theme.js'
import type { CommandContext } from '../src/ui/commands/context.js'

vi.mock('../src/ui/dialogs.js', () => ({ showChoice: vi.fn(), showImagePreview: vi.fn(), showMarkdownPreview: vi.fn() }))
vi.mock('../src/runtime/open.js', () => ({ systemRevealCommand: () => ({}), revealWithSystemApp: vi.fn(() => true) }))
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
beforeEach(() => { vi.clearAllMocks() })

async function fixture(sessionCwd = true) {
  const root = await mkdtemp(join(tmpdir(), 'native-tui-workspace-files-'))
  cleanup.push(root)
  const startup = join(root, 'A'), current = join(root, 'B')
  await mkdir(startup); await mkdir(current)
  await writeFile(join(startup, 'same.txt'), 'STARTUP_PRIVATE')
  await writeFile(join(current, 'same.txt'), 'CURRENT_EXPECTED')
  await writeFile(join(current, 'only-b.txt'), 'b')
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await writeFile(join(startup, 'same.png'), png)
  await writeFile(join(current, 'same.png'), png)
  const notices: string[] = []
  const saveFile = vi.fn(async ({ data, name }: { data: Uint8Array; name: string }) => ({ attachmentId: 'saved', name, bytes: data.byteLength }))
  const attachments = { saveFile, readImage: vi.fn(), readFileStream: async function* () {} }
  const events = [{ type: 'deliverables/presented', seq: 1, time: 1, data: { turn: 1, files: [{ path: 'same.txt' }] } }]
  const ctx = {
    config: { cwd: startup },
    active: { id: 'workspace-B', agent: { session: { header: { id: 'workspace-B', createdAt: 1, ...(sessionCwd ? { cwd: current } : {}) }, snapshotEvents: () => events } } },
    palette: createPalette('plain'), tui: {}, signal: new AbortController().signal,
    notice: (_tone: string, text: string) => { notices.push(text) }, renderStatus() {},
    host: { get: (name: string) => name === 'attachments' ? attachments : undefined },
    attachments: { pending: [], clear() {} }, modelSelection: {},
  } as unknown as CommandContext
  return { startup, current, ctx, notices, saveFile }
}

describe('file commands follow the active workspace', () => {
  it('opens the active Session file, not the startup namesake', async () => {
    const { ctx, notices } = await fixture()
    await openCommand(ctx, 'same.txt')
    expect(notices.join('\n')).toContain('CURRENT_EXPECTED')
    expect(notices.join('\n')).not.toContain('STARTUP_PRIVATE')
  })

  it('keeps absolute paths and falls back when the Session has no cwd', async () => {
    const { ctx, notices, current } = await fixture(false)
    await openCommand(ctx, 'same.txt')
    expect(notices.join('\n')).toContain('STARTUP_PRIVATE')
    notices.splice(0)
    await openCommand(ctx, join(current, 'same.txt'))
    expect(notices.join('\n')).toContain('CURRENT_EXPECTED')
  })

  it('stages bytes from the active workspace', async () => {
    const { ctx, saveFile } = await fixture()
    await attachCommand(ctx, 'same.txt')
    expect(saveFile).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(saveFile.mock.calls[0]![0].data)).toBe('CURRENT_EXPECTED')
    expect(ctx.attachments.pending).toHaveLength(1)
  })

  it('previews images from the active workspace', async () => {
    const { ctx, current } = await fixture()
    await previewCommand(ctx, 'same.png')
    expect(vi.mocked(showImagePreview).mock.calls[0]?.[2].path).toBe(join(current, 'same.png'))
  })

  it('starts the file browser in the active workspace', async () => {
    const { ctx, current } = await fixture()
    await filesCommand(ctx, '')
    const call = vi.mocked(showChoice).mock.calls[0]!
    expect(call[2]).toBe('Files · ' + current)
    expect(call[3].some(item => item.label === 'only-b.txt')).toBe(true)
  })

  it.each(['jsonl', 'html', 'zip'])('exports %s to the active workspace', async format => {
    const { ctx, current, startup } = await fixture()
    const name = 'out.' + format
    await exportCommand(ctx, format === 'jsonl' ? name : format + ' ' + name)
    const data = await readFile(join(current, name))
    expect(data.byteLength).toBeGreaterThan(0)
    await expect(readFile(join(startup, name))).rejects.toMatchObject({ code: 'ENOENT' })
    if (format === 'zip') {
      const zip = unzipSync(data)
      expect(new TextDecoder().decode(zip['deliverables/1-same.txt'])).toBe('CURRENT_EXPECTED')
    }
  })

  it('resolves relative deliverables for preview', async () => {
    const { ctx, notices } = await fixture()
    await deliverablesCommand(ctx, 'open 0')
    expect(notices.join('\n')).toContain('CURRENT_EXPECTED')
  })

  it('resolves relative deliverables before revealing them', async () => {
    const { ctx, current } = await fixture()
    vi.mocked(showChoice).mockResolvedValueOnce('yes')
    await deliverablesCommand(ctx, 'reveal 0')
    expect(revealWithSystemApp).toHaveBeenCalledWith(join(current, 'same.txt'))
  })
})
