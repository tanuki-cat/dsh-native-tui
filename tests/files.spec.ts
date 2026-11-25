import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMarkdownPath, listDirectory, readBoundedFile, readTextPreview, sanitizeTerminalText } from '../src/runtime/files.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-tui-files-'))
  cleanup.push(dir)
  return dir
}

describe('listDirectory', () => {
  it('sorts directories first and respects the entry cap', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'b-dir'))
    await mkdir(join(dir, 'a-dir'))
    await writeFile(join(dir, 'z.txt'), 'z')
    await writeFile(join(dir, 'a.txt'), 'a')
    const rows = await listDirectory(dir)
    expect(rows.map(row => row.name)).toEqual(['a-dir', 'b-dir', 'a.txt', 'z.txt'])
    expect(rows[0]?.kind).toBe('directory')
    expect(await listDirectory(dir, 2)).toHaveLength(2)
    await expect(listDirectory(join(dir, 'a.txt'))).rejects.toThrow()
  })

  it('keeps the sorted page without materializing every entry', async () => {
    const dir = await tempDir()
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(dir, 'file-' + String(index).padStart(2, '0') + '.txt'), 'x')
    }
    await mkdir(join(dir, 'zz-dir'))
    const rows = await listDirectory(dir, 5)
    expect(rows).toHaveLength(5)
    expect(rows.map(row => row.name)).toEqual(['zz-dir', 'file-00.txt', 'file-01.txt', 'file-02.txt', 'file-03.txt'])
  })
})

describe('isMarkdownPath', () => {
  it('accepts markdown extensions case-insensitively', () => {
    expect(isMarkdownPath('/tmp/a.md')).toBe(true)
    expect(isMarkdownPath('/tmp/a.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('/tmp/a.mdx')).toBe(true)
    expect(isMarkdownPath('/tmp/a.txt')).toBe(false)
    expect(isMarkdownPath('/tmp/a.ts')).toBe(false)
  })
})

describe('readTextPreview', () => {
  it('strips terminal controls and reports truncation', async () => {
    const dir = await tempDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'hello\u001B[31mred\u001B[0m\n' + 'x'.repeat(40))
    const preview = await readTextPreview(file, 20)
    expect(preview.bytes).toBeGreaterThan(20)
    expect(preview.truncated).toBe(true)
    expect(preview.text).toContain('hello')
    expect(preview.text).not.toContain('\u001B')
  })

  it.each(['', '中文🙂', 'abcde'])('preserves bounded file content %j', async content => {
    const dir = await tempDir()
    const path = join(dir, 'utf8.txt')
    await writeFile(path, content)
    const bytes = Buffer.byteLength(content)
    expect(await readTextPreview(path, Math.max(1, bytes))).toEqual({ path, text: content, bytes, truncated: false })
  })

  it('rejects missing files and directories', async () => {
    const dir = await tempDir()
    await expect(readTextPreview(join(dir, 'missing.txt'))).rejects.toThrow()
    await expect(readTextPreview(dir)).rejects.toThrow('not a regular file')
  })

  it('sanitizes controls but preserves tabs and newlines', () => {
    expect(sanitizeTerminalText('a\tb\nc\u0007d\u001B[31m')).toBe('a\tb\ncd')
  })
})

describe('readBoundedFile', () => {
  it('keeps the returned buffer proportional to the file, not the limit', async () => {
    const dir = await tempDir()
    const path = join(dir, 'small.bin')
    await writeFile(path, 'tiny')
    // `/export zip` reads every deliverable with a 16 MiB cap; a subarray view
    // of that allocation would pin 16 MiB per small file.
    const buffer = await readBoundedFile(path, 16 * 1024 * 1024, 'deliverable')
    expect(buffer.toString()).toBe('tiny')
    expect(buffer.buffer.byteLength).toBe(4)
  })

  it('rejects files over the limit and non-regular paths', async () => {
    const dir = await tempDir()
    const path = join(dir, 'big.bin')
    await writeFile(path, '12345')
    await expect(readBoundedFile(path, 4, 'deliverable')).rejects.toThrow('deliverable is 5 bytes; limit is 4')
    await expect(readBoundedFile(dir, 1024)).rejects.toThrow('not a regular file')
  })

  const withFifo = process.platform === 'win32' ? it.skip : it
  withFifo('rejects a named pipe before opening it', async () => {
    const dir = await tempDir()
    const fifo = join(dir, 'pipe')
    const made = spawnSync('mkfifo', [fifo])
    if (made.status !== 0) return
    await expect(readBoundedFile(fifo, 1024)).rejects.toThrow('not a regular file')
    await expect(readTextPreview(fifo)).rejects.toThrow('not a regular file')
  })
})
