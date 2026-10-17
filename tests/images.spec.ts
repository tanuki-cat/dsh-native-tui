import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readImagePreview } from '../src/runtime/images.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('readImagePreview', () => {
  it('returns base64 and media type for a PNG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-image-'))
    cleanup.push(dir)
    const path = join(dir, 'pixel.png')
    await writeFile(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
    const preview = await readImagePreview(path)
    expect(preview.name).toBe('pixel.png')
    expect(preview.mediaType).toBe('image/png')
    expect(preview.base64.length).toBeGreaterThan(0)
  })

  it('rejects text and oversized files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-image-'))
    cleanup.push(dir)
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello')
    await expect(readImagePreview(path)).rejects.toThrow('unsupported image format')
    await expect(readImagePreview(path, 2)).rejects.toThrow('terminal image limit')
  })
})
