import { CURSOR_MARKER, CombinedAutocompleteProvider, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentsService, PendingAttachment } from '../src/runtime/attachments.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { wireImageInput } from '../src/ui/image-input.js'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'
import { resolveConfig } from '../src/config.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const originalCapabilities = getCapabilities()
const controllers: AbortController[] = []
beforeEach(() => { setCapabilities({ ...originalCapabilities, images: 'kitty' }) })
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort())
  setCapabilities(originalCapabilities)
})
const imageLine = (line: string) => line.includes('\x1b_G') || line.includes('\x1b]1337;File=')
const image = (index: number): PendingAttachment => ({
  kind: 'image', label: '/private/long/path/screenshot-' + index + '.png',
  block: { type: 'image', attachment: { attachmentId: String(index), mediaType: 'image/png' } as never },
})

function harness(count = 1, rows = 30, thumbnails = true) {
  const controller = new AbortController()
  controllers.push(controller)
  const pending = Array.from({ length: count }, (_, index) => image(index))
  const readImage = vi.fn<AttachmentsService['readImage']>(async () => ({ data: png }))
  let overlay: Component | undefined
  const hide = vi.fn(() => { overlay = undefined })
  const tui = { terminal: { rows }, requestRender: vi.fn(), hasOverlay: () => overlay !== undefined,
    showOverlay: vi.fn((component: Component) => { overlay = component; return { hide, focus() {} } }),
  }
  const ctx = { host: { get: () => ({ readImage }) }, attachments: { pending }, tui,
    config: resolveConfig({ showImageThumbnails: thumbnails }),
    palette: createPalette('plain'), signal: controller.signal } as unknown as CommandContext
  const editor = new PromptEditor(tui as never, editorTheme(ctx.palette))
  editor.focused = true
  editor.placeholder = 'Ask DeepSeek Harness to do anything'
  wireImageInput(editor, () => ctx)
  return { editor, ctx, pending, readImage, tui, controller, hide, viewer: () => overlay }
}

describe('composer image previews', () => {
  it('keeps labels and manual preview available while automatic thumbnails are disabled', async () => {
    const h = harness(1, 30, false)
    const lines = h.editor.render(80)
    expect(lines.join('\n')).toContain('› [Image #1]')
    expect(lines.some(imageLine)).toBe(false)
    expect(h.readImage).not.toHaveBeenCalled()
    h.editor.handleInput('\x1bi')
    await vi.waitFor(() => expect(h.viewer()?.render(80).some(imageLine)).toBe(true))
    expect(h.pending).toHaveLength(1)
  })

  it('shows thumbnails when enabled live and releases them when disabled', async () => {
    const h = harness(1, 30, false)
    h.editor.render(80)
    expect(h.readImage).not.toHaveBeenCalled()
    h.ctx.config.showImageThumbnails = true
    h.editor.render(80)
    await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalledOnce())
    expect(h.editor.render(80).some(imageLine)).toBe(true)
    const signal = h.readImage.mock.calls[0]?.[1]
    h.ctx.config.showImageThumbnails = false
    const lines = h.editor.render(80)
    expect(signal?.aborted).toBe(true)
    expect(lines.some(imageLine)).toBe(false)
    expect(lines.join('\n')).toContain('› [Image #1]')
    expect(h.pending).toHaveLength(1)
    h.ctx.config.showImageThumbnails = true
    h.editor.render(80)
    await vi.waitFor(() => expect(h.readImage).toHaveBeenCalledTimes(2))
    expect(h.editor.render(80).some(imageLine)).toBe(true)
  })

  it('ignores a late thumbnail read after it is disabled', async () => {
    const h = harness()
    let finish!: (value: { data: Uint8Array }) => void
    const loaded = new Promise<{ data: Uint8Array }>(resolve => { finish = resolve })
    h.readImage.mockReturnValueOnce(loaded)
    h.editor.render(80)
    h.ctx.config.showImageThumbnails = false
    h.editor.render(80)
    expect(h.readImage.mock.calls[0]?.[1]?.aborted).toBe(true)
    finish({ data: png })
    await loaded
    await Promise.resolve()
    expect(h.tui.requestRender).not.toHaveBeenCalled()
    expect(h.editor.render(80).some(imageLine)).toBe(false)
    expect(h.pending).toHaveLength(1)
  })

  it.each(['kitty', 'iterm2'] as const)('automatically renders a bounded %s thumbnail and keeps labels beside the native cursor', async protocol => {
    setCapabilities({ ...originalCapabilities, images: protocol })
    const h = harness()
    h.editor.render(80)
    await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalledTimes(1))
    const lines = h.editor.render(80)
    expect(lines.some(imageLine)).toBe(true)
    const prompt = lines.find(line => line.startsWith('› '))!
    expect(prompt).toContain('› [Image #1] ' + CURSOR_MARKER)
    expect(lines.findIndex(imageLine)).toBeLessThan(lines.indexOf(prompt))
    expect(lines.join('\n')).not.toContain('/private/long')
    expect(lines.join('\n')).not.toContain('Ask DeepSeek')
    expect(h.editor.getText()).toBe('')
    expect(h.readImage).toHaveBeenCalledTimes(1)
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines.filter(line => !imageLine(line)).every(line => visibleWidth(line.replace(CURSOR_MARKER, '')) <= 80)).toBe(true)
    const protocolLine = lines.find(imageLine)!
    if (protocol === 'iterm2') expect(protocolLine).toContain('width=8;')
    else expect(protocolLine).toMatch(/c=8,r=4/u)
    h.editor.render(60)
    expect(h.readImage).toHaveBeenCalledTimes(1)
  })

  it('skips image reads for unsupported, narrow and short terminals', () => {
    const h = harness()
    h.editor.render(16)
    expect(h.readImage).not.toHaveBeenCalled()
    h.tui.terminal.rows = 8
    h.editor.render(80)
    expect(h.readImage).not.toHaveBeenCalled()
    h.tui.terminal.rows = 30
    setCapabilities({ ...originalCapabilities, images: null })
    expect(h.editor.render(80).join('\n')).toContain('› [Image #1] ')
    expect(h.readImage).not.toHaveBeenCalled()
  })

  it('bounds multi-image preview reads and updates numbering after removal', async () => {
    const h = harness(5)
    h.editor.render(120)
    await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalledTimes(2))
    let lines = h.editor.render(120)
    expect(lines.filter(imageLine)).toHaveLength(2)
    expect(lines.join('\n')).toContain('[Image #5]')
    expect(lines.length).toBeLessThanOrEqual(9)
    expect(h.readImage).toHaveBeenCalledTimes(2)
    h.pending.splice(0, 1)
    h.editor.render(120)
    await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalledTimes(3))
    lines = h.editor.render(120)
    expect(lines.join('\n')).not.toContain('[Image #5]')
    expect(h.readImage.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it.each(['remove', 'switch', 'dispose'] as const)('ignores a late image read after %s', async action => {
    const h = harness()
    let resolve!: (value: { data: Uint8Array }) => void
    const loaded = new Promise<{ data: Uint8Array }>(done => { resolve = done })
    h.readImage.mockReturnValueOnce(loaded)
    h.editor.render(80)
    const signal = h.readImage.mock.calls[0]?.[1]
    if (action === 'dispose') h.controller.abort()
    else {
      h.pending.splice(0)
      if (action === 'switch') h.pending.push(image(2))
      h.editor.render(80)
    }
    expect(signal?.aborted).toBe(true)
    if (action === 'switch') await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalledTimes(1))
    const renders = h.tui.requestRender.mock.calls.length
    resolve({ data: png })
    await loaded
    await Promise.resolve()
    expect(h.tui.requestRender).toHaveBeenCalledTimes(renders)
  })

  it('keeps a failed preview sendable without retrying it on every repaint', async () => {
    const h = harness()
    h.readImage.mockRejectedValueOnce(new Error('temporarily unavailable'))
    h.editor.render(80)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.editor.render(80).join('\n')).toContain('[Image #1]')
    expect(h.pending).toHaveLength(1)
    expect(h.readImage).toHaveBeenCalledTimes(1)
    expect(h.tui.requestRender).not.toHaveBeenCalled()
  })

  it('keeps slash suggestions above thumbnails and maps the shifted input mouse coordinates', async () => {
    const h = harness()
    h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'help' }], process.cwd(), null))
    h.editor.handleInput('/')
    await vi.waitFor(() => expect(h.editor.isShowingAutocomplete()).toBe(true))
    h.editor.render(80)
    await vi.waitFor(() => expect(h.tui.requestRender).toHaveBeenCalled())
    const lines = h.editor.render(80)
    expect(lines[0]).toContain('› help')
    expect(lines.findIndex(imageLine)).toBeGreaterThan(0)
    const promptRow = lines.findLastIndex(line => line.startsWith('› [Image #1]'))
    const plain = stripTerminalSequences(lines[promptRow]!.replace(CURSOR_MARKER, ''))
    const textColumn = plain.indexOf('/')
    h.editor.handleMouse({ type: 'click', button: 'left', x: textColumn, y: promptRow, width: 80, height: lines.length } as never)
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 0 })
    h.editor.handleInput('\x1b[C')
    h.editor.handleInput('\t')
    expect(h.editor.getText()).toBe('/help ')
  })

  it('opens a viewer from Alt+I, suppresses background thumbnails and restores the draft and cursor', async () => {
    const h = harness(2)
    h.editor.setText('draft text')
    h.editor.handleInput('\x1b[D')
    const cursor = h.editor.getCursor()
    h.editor.render(80)
    await vi.waitFor(() => expect(h.readImage).toHaveBeenCalledTimes(2))
    h.editor.handleInput('\x1bi')
    expect(h.tui.showOverlay).toHaveBeenCalledOnce()
    expect(h.editor.render(80).some(imageLine)).toBe(false)
    await vi.waitFor(() => expect(h.viewer()?.render(80).join('\n')).toContain('image/png'))
    expect(h.viewer()?.render(80).join('\n')).toContain('Image · 1/2')
    h.editor.handleInput('\x1bi')
    expect(h.tui.showOverlay).toHaveBeenCalledOnce()
    h.viewer()?.handleInput?.('\x1b[C')
    await vi.waitFor(() => expect(h.viewer()?.render(80).join('\n')).toContain('Image · 2/2'))
    h.viewer()?.handleInput?.('\x1b')
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.editor.getText()).toBe('draft text')
    expect(h.editor.getCursor()).toEqual(cursor)
    expect(h.pending).toHaveLength(2)
  })

  it('opens the clicked thumbnail even when slash suggestions precede the composer', async () => {
    const h = harness(2)
    h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'help' }], process.cwd(), null))
    h.editor.handleInput('/')
    await vi.waitFor(() => expect(h.editor.isShowingAutocomplete()).toBe(true))
    h.editor.render(80)
    await vi.waitFor(() => expect(h.readImage).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    const lines = h.editor.render(80)
    const row = lines.findIndex(line => line.includes('[Image #2] · Alt+I'))
    expect(row).toBeGreaterThan(0)
    expect(h.editor.handleMouse({ type: 'click', button: 'left', x: 3, y: row + 1, width: 80, height: lines.length } as never)?.handled).toBe(true)
    expect(h.viewer()?.render(80).join('\n')).toContain('Image · 2/2')
    expect(h.editor.getText()).toBe('/')
  })

  it('opens images beyond the thumbnail limit by clicking their inline label', () => {
    setCapabilities({ ...originalCapabilities, images: null })
    const h = harness(3)
    const lines = h.editor.render(120)
    h.editor.handleMouse({ type: 'click', button: 'left', x: 26, y: 1, width: 120, height: lines.length } as never)
    expect(h.viewer()?.render(80).join('\n')).toContain('Image · 3/3')
    expect(h.pending).toHaveLength(3)
  })

  it('opens a separate label row in a narrow terminal without moving the text cursor', () => {
    const h = harness()
    h.editor.setText('hello')
    const lines = h.editor.render(16)
    const cursor = h.editor.getCursor()
    const row = lines.findIndex(line => line.includes('[Image #1]'))
    h.editor.handleMouse({ type: 'click', button: 'left', x: 3, y: row, width: 16, height: lines.length } as never)
    expect(h.tui.showOverlay).toHaveBeenCalledOnce()
    expect(h.editor.getCursor()).toEqual(cursor)
  })

  it('does not open over another dialog or without staged images', () => {
    const h = harness(0)
    h.editor.handleInput('\x1bi')
    expect(h.tui.showOverlay).not.toHaveBeenCalled()
    h.pending.push(image(0))
    h.tui.showOverlay({ render: () => [], invalidate() {} })
    h.editor.handleInput('\x1bi')
    expect(h.tui.showOverlay).toHaveBeenCalledOnce()
  })

  it('closes an old session viewer on the next render and aborts its pending image read', async () => {
    const h = harness()
    const isCurrent = vi.fn(() => true)
    Object.assign(h.ctx, { isCurrent })
    h.readImage.mockImplementationOnce(() => new Promise(() => {}))
    h.editor.handleInput('\x1bi')
    await vi.waitFor(() => expect(h.readImage).toHaveBeenCalledOnce())
    isCurrent.mockReturnValue(false)
    h.editor.render(80)
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.readImage.mock.calls[0]?.[1]?.aborted).toBe(true)
  })
})
