import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDeliverables, formatDeliverables, readContainedDeliverable } from '../src/runtime/deliverables.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-tui-deliverables-'))
  cleanup.push(dir)
  return dir
}

const withSymlinks = process.platform === 'win32' ? it.skip : it

describe('collectDeliverables', () => {
  it('keeps the latest description and turn per path', () => {
    const rows = collectDeliverables([
      { turn: 1, files: [{ path: '/tmp/a.md', description: 'old' }] },
      { turn: 2, files: [{ path: '/tmp/a.md', description: 'new' }, { path: '/tmp/b.md' }] },
    ])
    expect(rows).toEqual([
      { path: '/tmp/a.md', description: 'new', turn: 2 },
      { path: '/tmp/b.md', turn: 2 },
    ])
  })
})

describe('formatDeliverables', () => {
  it('lists latest declarations and de-duplicates paths', () => {
    const text = formatDeliverables([
      { turn: 1, files: [{ path: '/tmp/report.md', description: 'report' }] },
      { turn: 2, files: [{ path: '/tmp/report.md', description: 'updated report' }, { path: '/tmp/slides.pptx' }] },
    ])
    expect(text).toContain('Deliverables · 2 file(s)')
    expect(text).toContain('/tmp/report.md — updated report  (turn 2)')
    expect(text).toContain('/tmp/slides.pptx  (turn 2)')
    expect(text).not.toContain('turn 1')
  })

  it('handles an empty list and caps rows', () => {
    expect(formatDeliverables([])).toBe('No presented deliverables.')
    const events = [{ turn: 1, files: Array.from({ length: 5 }, (_, index) => ({ path: '/tmp/f' + String(index) })) }]
    const text = formatDeliverables(events, 2)
    expect(text).toContain('3 more file(s)')
  })
})

describe('readContainedDeliverable', () => {
  it('reads a contained file through one resolved path', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'report.md'), '# report\n')
    const read = await readContainedDeliverable(dir, 'report.md', 1024)
    expect(read.data.toString()).toBe('# report\n')
    expect(read.absolute).toBe(join(dir, 'report.md'))
    expect(read.real.endsWith('report.md')).toBe(true)
  })

  it('rejects lexical traversal outside the workspace', async () => {
    const dir = await tempDir()
    await expect(readContainedDeliverable(dir, '../secret.md', 1024)).rejects.toThrow('outside the session workspace')
  })

  withSymlinks('rejects a symlink at the final component', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'real.md'), 'inside\n')
    await symlink(join(dir, 'real.md'), join(dir, 'link.md'))
    await expect(readContainedDeliverable(dir, 'link.md', 1024)).rejects.toThrow('is a symbolic link')
  })

  it('enforces the size cap from the opened descriptor', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'big.bin'), '12345')
    await expect(readContainedDeliverable(dir, 'big.bin', 4)).rejects.toThrow('deliverable is 5 bytes; limit is 4')
  })
})