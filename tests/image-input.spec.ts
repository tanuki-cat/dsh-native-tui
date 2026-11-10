import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imagePathReferences, importImagePaste } from '../src/runtime/image-input.js'
import type { AttachmentsService, PendingAttachment } from '../src/runtime/attachments.js'
import { wireImageInput } from '../src/ui/image-input.js'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { enqueuePrompt, submitDraft } from '../src/ui/prompt-submission.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const roots: string[] = []
const originalCapabilities = getCapabilities()
beforeEach(() => { setCapabilities({ ...originalCapabilities, images: null }) })
afterEach(() => { setCapabilities(originalCapabilities) })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const paste = (text: string) => '\x1b[200~' + text + '\x1b[201~'
const pendingImage = (name: string): PendingAttachment => ({ label: name, kind: 'image', block: { type: 'image', attachment: { attachmentId: name, mediaType: 'image/png' } as never } })

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'native-tui-image-input-'))
  roots.push(root)
  const path = join(root, 'long screenshot 中文.png')
  await writeFile(path, png)
  const pending: PendingAttachment[] = []
  const isCurrent = vi.fn(() => true)
  const saveImages = vi.fn<AttachmentsService['saveImages']>(async inputs => inputs.map(input => ({
    attachmentId: input.name!, mediaType: input.mediaType, name: input.name, bytes: input.data.byteLength, width: 1, height: 1,
  }) as never))
  const attachments: AttachmentsService = {
    saveImages, saveFile: vi.fn(), readImage: vi.fn(), readFileStream: vi.fn(),
  }
  const ctx = {
    host: { get: (name: string) => name === 'attachments' ? attachments : undefined },
    config: { cwd: root }, active: { agent: { session: { header: { cwd: root } } } },
    attachments: { pending }, palette: createPalette('plain'), modelSelection: {},
    signal: new AbortController().signal, isCurrent, notice: vi.fn(), renderStatus: vi.fn(),
  } as unknown as CommandContext
  const editor = new PromptEditor({ terminal: { rows: 30 }, requestRender: vi.fn() } as never, editorTheme(ctx.palette))
  editor.focused = true
  wireImageInput(editor, () => ctx)
  const run = (text: string) => importImagePaste(text, { cwd: root, attachments, pending, isCurrent: () => ctx.isCurrent?.() ?? true, onError: ctx.notice as never })
  return { root, path, pending, saveImages, ctx, editor, run, isCurrent }
}

describe('image path references', () => {
  it.each([
    ['@/tmp/shot.png', '/tmp/shot.png'], ['"/tmp/屏幕 截图.PNG"', '/tmp/屏幕 截图.PNG'],
    ["@'./shot one.jpg'", './shot one.jpg'], ['/tmp/shot\\ one.webp', '/tmp/shot one.webp'],
    ['~/shot.gif', homedir() + '/shot.gif'], [pathToFileURL('/tmp/shot one.png').href, '/tmp/shot one.png'],
  ])('recognizes %s without shell evaluation', (input, path) => {
    expect(imagePathReferences(input)).toEqual([{ start: 0, end: input.length, path }])
  })
  it('recognizes multiple paths and explicit mentions in prose', () => {
    expect(imagePathReferences('/tmp/a.png\n"./b c.jpg"').map(ref => ref.path)).toEqual(['/tmp/a.png', './b c.jpg'])
    expect(imagePathReferences('参考 @"/tmp/a b.png" 与 @second.png 优化').map(ref => ref.path)).toEqual(['/tmp/a b.png', 'second.png'])
  })
  it.each(['/attach /tmp/a.png', '/preview /tmp/a.png', 'describe /tmp/a.png please', 'https://example.com/a.png', 'picture.png', '@notes.txt', 'example@image.png', 'plain text', '"unfinished.png'])('preserves ordinary input: %s', text => {
    expect(imagePathReferences(text)).toEqual([])
  })
})

describe('image imports', () => {
  it('saves the original image and removes only its reference from prose', async () => {
    const h = await harness()
    expect(await h.run('参考 @"' + h.path + '" 优化')).toBe('参考  优化')
    expect(h.pending).toHaveLength(1)
    expect(h.saveImages.mock.calls[0]?.[0][0]?.data).toEqual(png)
    expect(h.pending[0]?.block).toMatchObject({ type: 'image', attachment: { name: 'long screenshot 中文.png' } })
  })
  it('keeps the editor empty after a list of images separated by whitespace', async () => {
    const h = await harness()
    h.editor.handleInput(paste('"' + h.path + '"\n"' + h.path + '" '))
    await h.editor.whenInputIdle()
    expect(h.editor.getText()).toBe('')
    expect(h.pending).toHaveLength(2)
    h.editor.handleInput('\x7f')
    expect(h.pending).toHaveLength(1)
  })
  it('retains missing, invalid and oversized image references while importing valid siblings', async () => {
    const h = await harness()
    await writeFile(join(h.root, 'invalid.png'), 'not an image')
    await writeFile(join(h.root, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1))
    const bad = '@missing.png @invalid.png @large.png '
    expect(await h.run(bad + '@"' + h.path + '"')).toBe(bad)
    expect(h.pending).toHaveLength(1)
    expect(h.ctx.notice).toHaveBeenCalledTimes(3)
    expect(h.saveImages).toHaveBeenCalledTimes(1)
  })
  it('keeps input when the Host rejects storage or the session has changed', async () => {
    const h = await harness(), text = '"' + h.path + '"'
    h.saveImages.mockRejectedValueOnce(new Error('storage unavailable'))
    expect(await h.run(text)).toBe(text)
    expect(h.pending).toHaveLength(0)
    h.isCurrent.mockReturnValue(false)
    expect(await h.run(text)).toBe(text)
    expect(h.pending).toHaveLength(0)
  })
})

describe('image composer', () => {
  it('orders fragmented paste, continued typing and immediate Enter after image storage', async () => {
    const h = await harness(), followup = vi.fn()
    h.editor.onSubmit = text => { submitDraft(text, h.editor, () => enqueuePrompt({ status: 'idle', followup, steer: vi.fn() }, text, h.pending)) }
    h.editor.handleInput('\x1b[200~@"' + h.path.slice(0, 15))
    h.editor.handleInput(h.path.slice(15) + '"\x1b[201~')
    h.editor.handleInput('describe this')
    h.editor.handleInput('\r')
    await h.editor.whenInputIdle()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]?.[0].content).toMatchObject([{ type: 'text', text: 'describe this' }, { type: 'image' }])
    expect(h.editor.getText()).toBe('')
    expect(h.pending).toHaveLength(0)
  })
  it('serializes multiple pastes and preserves failed-admission text and tags', async () => {
    const h = await harness()
    h.editor.onSubmit = text => { submitDraft(text, h.editor, () => false) }
    h.editor.handleInput(paste('@"' + h.path + '"'))
    h.editor.handleInput(paste('@"' + h.path + '"'))
    h.editor.handleInput('retry')
    // Keys arrive separately from the native terminal parser.
    h.editor.handleInput('\r')
    await h.editor.whenInputIdle()
    expect(h.pending).toHaveLength(2)
    expect(h.editor.render(100).join('\n')).toContain('[Image #1] [Image #2]')
    expect(h.editor.getText()).toContain('retry')
  })
  it('keeps command arguments and unavailable-service paths as text', async () => {
    const h = await harness()
    h.editor.setText('/preview ')
    h.editor.handleInput(paste('"' + h.path + '"'))
    await h.editor.whenInputIdle()
    expect(h.editor.getText()).toContain(h.path)
    expect(h.pending).toHaveLength(0)
    h.editor.setText('')
    vi.spyOn(h.ctx.host, 'get').mockReturnValue(undefined)
    h.editor.handleInput(paste('@"' + h.path + '"'))
    await h.editor.whenInputIdle()
    expect(h.editor.getText()).toContain(h.path)
  })
  it('keeps normal large pastes synchronous, expandable and undoable', async () => {
    const h = await harness(), text = 'ordinary pasted text '.repeat(100)
    h.editor.handleInput(paste(text))
    expect(h.editor.getExpandedText()).toBe(text)
    expect(h.pending).toHaveLength(0)
    // The native undo binding is Ctrl+minus (ASCII unit separator).
    h.editor.handleInput('\x1f')
    expect(h.editor.getText()).toBe('')
  })
  it('orders a global clear between a pending import and subsequent typing', async () => {
    const h = await harness()
    h.editor.setText('old draft')
    h.editor.handleInput(paste('@"' + h.path + '"'))
    expect(h.editor.isProcessingPaste).toBe(true)
    h.editor.deferInput(() => h.editor.setText(''))
    h.editor.handleInput('new draft')
    await h.editor.whenInputIdle()
    expect(h.editor.getText()).toBe('new draft')
    expect(h.pending).toHaveLength(1)
  })
  it('keeps slash completion above the input and applies it while chips are visible', async () => {
    const h = await harness()
    h.pending.push(pendingImage('clipboard.png'))
    h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'help', description: 'Show help' }], h.root, null))
    h.editor.handleInput('/')
    await vi.waitFor(() => expect(h.editor.isShowingAutocomplete()).toBe(true))
    const lines = h.editor.render(80)
    expect(lines[0]).toContain('› help')
    expect(lines.findLastIndex(line => line.startsWith('› [Image #1]'))).toBeGreaterThan(0)
    h.editor.handleInput('\t')
    expect(h.editor.getText()).toBe('/help ')
  })
  it('renders every image entry point compactly, bounds narrow rows and preserves mouse offsets', async () => {
    const h = await harness()
    h.pending.push(pendingImage('/very/long/private/image.png'), pendingImage('clipboard.png'))
    h.editor.setText('hello')
    expect(h.editor.render(100)[1]).toContain('› [Image #1] [Image #2] hello')
    expect(h.editor.render(100).join('\n')).not.toContain('/very/long')
    expect(visibleWidth(h.editor.render(1)[0]!)).toBeLessThanOrEqual(1)
    for (const width of [2, 8, 24, 80]) {
      expect(h.editor.render(width).every(line => visibleWidth(stripTerminalSequences(line.replace(CURSOR_MARKER, ''))) <= width)).toBe(true)
      expect(h.editor.render(width)[0]).not.toContain('\x1b')
    }
    h.editor.render(40)
    const lines = h.editor.render(100)
    const prompt = lines[1]!
    const textColumn = visibleWidth(prompt.slice(0, prompt.indexOf('hello')))
    h.editor.handleMouse({ type: 'click', button: 'left', x: textColumn + 2, y: 1, width: 100, height: 3 } as never)
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 2 })
  })
  it('removes the last image on empty Backspace and leaves files intact', async () => {
    const h = await harness()
    const file: PendingAttachment = { kind: 'file', label: 'notes.txt', block: { type: 'text', text: 'notes' } }
    h.pending.push(pendingImage('first.png'), file, pendingImage('second.png'))
    h.editor.setText('x')
    h.editor.handleInput('\x7f')
    expect(h.pending).toHaveLength(3)
    h.editor.handleInput('\x7f')
    expect(h.pending).toEqual([pendingImage('first.png'), file])
    h.editor.handleInput('\x7f')
    expect(h.pending).toEqual([file])
    expect(h.editor.render(80).join('\n')).not.toContain('[Image #')
  })
  it('preserves native wrapping, mouse placement, Unicode editing and undo with inline image labels', async () => {
    const h = await harness()
    h.pending.push(pendingImage('one.png'))
    const text = 'abcdefghij'.repeat(4) + '\n你好 next line'
    h.editor.setText(text)
    const lines = h.editor.render(40)
    const native = new Editor({ terminal: { rows: 30 }, requestRender: vi.fn() } as never, editorTheme(h.ctx.palette), { paddingX: 2 })
    native.setText(text)
    native.render(29)
    const event = { type: 'click', button: 'left', x: 4, y: 2, width: 29, height: lines.length } as const
    native.handleMouse(event as never)
    h.editor.handleMouse({ ...event, x: 15, width: 40 } as never)
    expect(h.editor.getCursor()).toEqual(native.getCursor())
    h.editor.handleInput('中')
    native.handleInput('中')
    expect(h.editor.getText()).toBe(native.getText())
    h.editor.handleInput('\x1f')
    expect(h.editor.getText()).toBe(text)
    expect(lines.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
    expect(lines.every(line => visibleWidth(line.replace(CURSOR_MARKER, '')) <= 40)).toBe(true)
    h.pending.splice(0)
    expect(h.editor.render(40).join('\n')).not.toContain('[Image #')
    expect(h.editor.getText()).toBe(text)
  })
  it('cancels queued text and a late import when the terminal is disposed', async () => {
    const h = await harness()
    h.editor.handleInput(paste('@"' + h.path + '"'))
    h.editor.handleInput('stale draft')
    h.editor.cancelPendingInput()
    h.isCurrent.mockReturnValue(false)
    await h.editor.whenInputIdle()
    expect(h.editor.getText()).toBe('')
    expect(h.pending).toHaveLength(0)
  })
})
