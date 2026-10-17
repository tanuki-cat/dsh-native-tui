import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectImageMediaType, imageExtension, loadAttachment, type AttachmentsService } from '../src/runtime/attachments.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function service(): AttachmentsService {
  return {
    saveFile: async input => ({
      attachmentId: 'file-1',
      name: input.name ?? 'file',
      bytes: input.data.byteLength,
    }) as never,
    saveImages: async inputs => inputs.map((input, index) => ({
      attachmentId: 'image-' + String(index),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    })) as never,
    readImage: async () => ({ data: Uint8Array.from([]) }),
    readFileStream: async function* () {},
  }
}

describe('detectImageMediaType', () => {
  it('sniffs png, jpeg, gif, and webp signatures', () => {
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMediaType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif')
    expect(detectImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(detectImageMediaType(new TextEncoder().encode('plain text'))).toBeUndefined()
    expect(imageExtension('image/jpeg')).toBe('.jpg')
    expect(imageExtension('image/gif')).toBe('.gif')
  })
})

describe('loadAttachment', () => {
  it('commits text files through saveFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-attach-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'note.txt'), 'hello')
    const result = await loadAttachment('note.txt', dir, service())
    expect(result.label).toBe('note.txt')
    expect(result.kind).toBe('file')
    expect(result.block).toMatchObject({ type: 'file', attachment: { attachmentId: 'file-1' } })
  })

  it('commits image extensions through saveImages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-attach-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'pixel.png'), Uint8Array.from([137, 80, 78, 71]))
    const result = await loadAttachment('pixel.png', dir, service())
    expect(result.kind).toBe('image')
    expect(result.block).toMatchObject({
      type: 'image',
      attachment: { attachmentId: 'image-0', mediaType: 'image/png' },
    })
  })

  it('refuses files over the terminal limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-tui-attach-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'big.txt'), '12345')
    await expect(loadAttachment('big.txt', dir, service(), 4)).rejects.toThrow('terminal attachment limit')
  })
})