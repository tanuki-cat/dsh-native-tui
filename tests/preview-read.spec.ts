import * as fs from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readTextPreview } from '../src/runtime/files.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
})
beforeEach(() => { vi.resetAllMocks() })

function fileHandle(size: number, regular = true) {
  const data = Buffer.from('abcdef')
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = Math.min(2, length, data.length - position)
    data.copy(buffer, offset, position, position + bytesRead)
    return { bytesRead, buffer }
  })
  const stat = vi.fn(async () => ({ size, isFile: () => regular }))
  const close = vi.fn(async () => {})
  vi.mocked(fs.open).mockResolvedValue({ read, stat, close } as unknown as Awaited<ReturnType<typeof fs.open>>)
  vi.mocked(fs.stat).mockResolvedValue({ size, isFile: () => regular } as Awaited<ReturnType<typeof fs.stat>>)
  vi.mocked(fs.readFile).mockResolvedValue(data)
  return { read, close }
}

describe('bounded preview reads', () => {
  it('reads only the byte budget even when a regular file reports a huge size', async () => {
    const handle = fileHandle(2 ** 30)
    const result = await readTextPreview('synthetic.log', 5)
    expect(result).toEqual({ path: 'synthetic.log', text: 'abcde', bytes: 2 ** 30, truncated: true })
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(handle.read).toHaveBeenCalledTimes(3)
    for (const [buffer, offset, length, position] of handle.read.mock.calls) {
      expect(buffer.byteLength).toBe(5)
      expect(position).toBe(offset)
      expect(offset + length).toBeLessThanOrEqual(5)
    }
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('handles short reads and stops at EOF', async () => {
    const handle = fileHandle(6)
    const result = await readTextPreview('short.txt', 20)
    expect(result).toEqual({ path: 'short.txt', text: 'abcdef', bytes: 6, truncated: false })
    expect(handle.read).toHaveBeenCalledTimes(4)
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('closes the owned descriptor on read and non-regular-file errors', async () => {
    const broken = fileHandle(6)
    broken.read.mockRejectedValueOnce(new Error('read failed'))
    await expect(readTextPreview('broken.txt')).rejects.toThrow('read failed')
    expect(broken.close).toHaveBeenCalledOnce()
    const directory = fileHandle(6, false)
    await expect(readTextPreview('directory')).rejects.toThrow('not a regular file')
    expect(directory.read).not.toHaveBeenCalled()
    expect(directory.close).toHaveBeenCalledOnce()
  })
})
