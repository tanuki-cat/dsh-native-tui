import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMarkdownPath, listDirectory, readTextPreview, sanitizeTerminalText } from '../src/runtime/files.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('listDirectory', () => {
  it('sorts directories first and respects the entry cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-files-'))
    cleanup.push(dir)
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
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-files-'))
    cleanup.push(dir)
    const file = join(dir, 'note.txt')
    await writeFile(file, 'hello\u001B[31mred\u001B[0m\n' + 'x'.repeat(40))
    const preview = await readTextPreview(file, 20)
    expect(preview.bytes).toBeGreaterThan(20)
    expect(preview.truncated).toBe(true)
    expect(preview.text).toContain('hello')
    expect(preview.text).not.toContain('\u001B')
  })

  it('rejects missing files and directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-files-'))
    cleanup.push(dir)
    await expect(readTextPreview(join(dir, 'missing.txt'))).rejects.toThrow()
    await expect(readTextPreview(dir)).rejects.toThrow('not a regular file')
  })

  it('sanitizes controls but preserves tabs and newlines', () => {
    expect(sanitizeTerminalText('a\tb\nc\u0007d\u001B[31m')).toBe('a\tb\ncd[31m')
  })
})