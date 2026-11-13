import { getCapabilities, setCapabilities, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImagePreview } from '../src/runtime/images.js'
import { showImageViewer, type ImageViewerSource } from '../src/ui/image-viewer.js'
import { showImagePreview } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const originalCapabilities = getCapabilities()
const controllers: AbortController[] = []
beforeEach(() => { setCapabilities({ ...originalCapabilities, images: 'kitty' }) })
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort())
  setCapabilities(originalCapabilities)
})
const pictureLine = (line: string) => line.includes('\x1b_G') || line.includes('\x1b]1337;File=')
const image = (name = 'shot.png'): ImagePreview => ({ path: name, name, mediaType: 'image/png', base64, bytes: 68 })

function harness(rows = 40) {
  const controller = new AbortController()
  controllers.push(controller)
  let component!: Component
  const hide = vi.fn(), focus = vi.fn(), requestRender = vi.fn()
  const tui = { terminal: { rows }, requestRender,
    showOverlay: vi.fn((value: Component) => { component = value; return { hide, focus } }),
  }
  const open = (sources: readonly ImageViewerSource[], index = 0) => showImageViewer(tui as never, createPalette('plain'), sources, index, controller.signal)
  return { tui, controller, hide, focus, requestRender, open,
    render: (width = 80) => component.render(width), key: (data: string) => component.handleInput?.(data) }
}

describe('image viewer', () => {
  it.each(['kitty', 'iterm2'] as const)('preserves the complete %s payload and bounds picture geometry on resize', async protocol => {
    setCapabilities({ ...originalCapabilities, images: protocol })
    const h = harness()
    const opened = h.open([{ name: 'shot.png', load: async () => image() }])
    await vi.waitFor(() => expect(h.render().some(pictureLine)).toBe(true))
    const wide = h.render(), protocolLine = wide.find(pictureLine)!
    expect(protocolLine).toContain(base64)
    expect(wide.length).toBeLessThanOrEqual(34)
    if (protocol === 'kitty') expect(protocolLine).toMatch(/c=58,r=29/u)
    else expect(protocolLine).toContain('width=58;')
    h.tui.terminal.rows = 16
    const narrow = h.render(40)
    expect(narrow.length).toBeLessThanOrEqual(13)
    if (protocol === 'kitty') expect(narrow.find(pictureLine)).toMatch(/c=16,r=8/u)
    else expect(narrow.find(pictureLine)).toContain('width=16;')
    expect(narrow.filter(line => !pictureLine(line)).every(line => visibleWidth(line) <= 40)).toBe(true)
    h.key('\x1b')
    await opened
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.focus).toHaveBeenCalledOnce()
  })

  it('shows a text fallback and keeps very narrow and short windows bounded', async () => {
    setCapabilities({ ...originalCapabilities, images: null })
    const h = harness()
    const opened = h.open([{ name: 'shot.png', load: async () => image() }])
    await vi.waitFor(() => expect(h.render().join('\n')).toContain('68 bytes'))
    expect(h.render().some(pictureLine)).toBe(false)
    expect(h.render().join('\n')).toContain('shot.png')
    for (const width of [1, 8, 18, 20]) expect(h.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    h.tui.terminal.rows = 5
    expect(h.render().length).toBeLessThanOrEqual(4)
    h.key('\r')
    await opened
  })

  it('opens the requested image, switches with arrows and ignores late reads from the previous image', async () => {
    const h = harness()
    let finish!: (value: ImagePreview) => void
    const slow = new Promise<ImagePreview>(resolve => { finish = resolve })
    const first = vi.fn(async () => image('first.png'))
    const second = vi.fn<ImageViewerSource['load']>(() => slow)
    const opened = h.open([{ name: 'first.png', load: first }, { name: 'second.png', load: second }], 1)
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
    expect(h.render().join('\n')).toContain('Image · 2/2')
    expect(h.render().join('\n')).toContain('Loading image')
    h.key('\x1b[D')
    await vi.waitFor(() => expect(h.render().join('\n')).toContain('68 bytes'))
    expect(second.mock.calls[0]?.[0].aborted).toBe(true)
    const renders = h.requestRender.mock.calls.length
    finish(image('late.png'))
    await slow
    await Promise.resolve()
    expect(h.requestRender).toHaveBeenCalledTimes(renders)
    expect(h.render().join('\n')).toContain('Image · 1/2 · first.png')
    h.key('\x1b[D')
    expect(first).toHaveBeenCalledOnce()
    h.key('\x1b[C')
    await vi.waitFor(() => expect(h.render().join('\n')).toContain('Image · 2/2 · second.png'))
    h.controller.abort()
    await opened
  })

  it('shows read failures inside the viewer and allows switching to a working image', async () => {
    const h = harness()
    const opened = h.open([
      { name: 'bad.png', load: async () => { throw new Error('\x1b[2Jnot available') } },
      { name: 'good.png', load: async () => image('good.png') },
    ])
    await vi.waitFor(() => expect(h.render().join('\n')).toContain('Could not load image: not available'))
    expect(h.render().join('\n')).not.toContain('\x1b[2J')
    h.key('\x1b[C')
    await vi.waitFor(() => expect(h.render().some(pictureLine)).toBe(true))
    h.key('\r')
    await opened
  })

  it('aborts an in-flight read when closed and never redraws its late result', async () => {
    const h = harness()
    let finish!: (value: ImagePreview) => void
    const slow = new Promise<ImagePreview>(resolve => { finish = resolve })
    const load = vi.fn<ImageViewerSource['load']>(() => slow)
    const opened = h.open([{ name: 'slow.png', load }])
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    h.key('\x1b')
    await opened
    expect(load.mock.calls[0]?.[0].aborted).toBe(true)
    const renders = h.requestRender.mock.calls.length
    finish(image())
    await slow
    await Promise.resolve()
    expect(h.requestRender).toHaveBeenCalledTimes(renders)
    expect(h.hide).toHaveBeenCalledOnce()
  })

  it('does not open for an empty gallery or an already aborted session', async () => {
    const h = harness(), load = vi.fn(async () => image())
    await h.open([])
    h.controller.abort()
    await h.open([{ name: 'shot.png', load }])
    expect(h.tui.showOverlay).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('cleans up a read if the terminal cannot open an overlay', async () => {
    const h = harness(), load = vi.fn<ImageViewerSource['load']>(async () => image())
    h.tui.showOverlay.mockImplementationOnce(() => { throw new Error('terminal closed') })
    await expect(h.open([{ name: 'shot.png', load }])).rejects.toThrow('terminal closed')
    await Promise.resolve()
    expect(load.mock.calls[0]?.[0].aborted).toBe(true)
  })

  it('reuses the viewer for the existing single-image preview API', async () => {
    const h = harness()
    const opened = showImagePreview(h.tui as never, createPalette('plain'), image(), h.controller.signal)
    await vi.waitFor(() => expect(h.tui.showOverlay).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(h.render().some(pictureLine)).toBe(true))
    expect(h.render().join('\n')).toContain('Image · 1/1 · shot.png')
    h.key('\x1b')
    await opened
  })
})
