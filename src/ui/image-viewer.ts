import { Image, getCapabilities, matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui'
import type { ImagePreview } from '../runtime/images.js'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { bindAbort, dialogFrame } from './dialogs.js'
import type { Palette } from './theme.js'

export interface ImageViewerSource {
  readonly name: string
  load(signal: AbortSignal): Promise<ImagePreview>
}

class ImageViewer implements Component {
  private index = -1
  private read = new AbortController()
  private preview?: ImagePreview
  private image?: Image
  private geometry = ''
  private error = ''

  constructor(
    private readonly tui: TUI,
    private readonly palette: Palette,
    private readonly sources: readonly ImageViewerSource[],
    index: number,
    private readonly close: () => void,
  ) { this.select(Math.max(0, Math.min(index, sources.length - 1))) }

  private select(index: number): void {
    if (index < 0 || index >= this.sources.length || index === this.index) return
    this.read.abort()
    const read = this.read = new AbortController()
    this.index = index
    this.preview = undefined
    this.image = undefined
    this.error = ''
    const source = this.sources[index]!
    void Promise.resolve().then(() => source.load(read.signal)).then(preview => {
      if (read.signal.aborted) return
      this.preview = preview
      this.tui.requestRender()
    }, error => {
      if (read.signal.aborted) return
      this.error = 'Could not load image: ' + sanitizeTerminalText(error instanceof Error ? error.message : String(error))
      this.tui.requestRender()
    })
    this.tui.requestRender()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4)
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85))
    const heading = 'Image · ' + String(this.index + 1) + '/' + String(this.sources.length)
      + ' · ' + sanitizeTerminalText(this.sources[this.index]!.name)
    const detail = this.preview === undefined ? ''
      : sanitizeTerminalText(this.preview.mediaType) + ' · ' + String(this.preview.bytes) + ' bytes'
    const pending = this.error || 'Loading image…'
    const hint = (this.sources.length > 1 ? '←/→ images · ' : '') + 'Enter/Esc closes'
    if (width < 20 || height < 6) return [heading, detail || pending, hint].slice(0, height).map(line => truncateToWidth(line, width, ''))
    const imageRows = height - 5
    const geometry = inner + ':' + imageRows + ':' + getCapabilities().images
    if (this.preview !== undefined && (this.image === undefined || this.geometry !== geometry)) {
      this.geometry = geometry
      this.image = new Image(this.preview.base64, this.preview.mediaType, { fallbackColor: text => this.palette.dim(text) }, {
        filename: sanitizeTerminalText(this.preview.name), maxWidthCells: inner - 2, maxHeightCells: imageRows,
      })
    }
    const picture = this.image?.render(inner) ?? [this.palette.dim(pending)]
    const frame = dialogFrame([
      this.palette.bold(truncateToWidth(heading, inner, '…')),
      this.palette.dim(truncateToWidth(detail, inner, '…')),
      ...picture.map(line => isPictureLine(line) ? '' : line),
      this.palette.dim(truncateToWidth(hint, inner, '…')),
    ], width, this.palette)
    for (const [row, line] of picture.entries()) {
      // Image protocols carry their own geometry; ordinary text framing must not truncate their payload.
      if (isPictureLine(line)) frame[row + 3] = '  ' + line
    }
    return frame
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) this.close()
    else if (matchesKey(data, 'left')) this.select(this.index - 1)
    else if (matchesKey(data, 'right')) this.select(this.index + 1)
  }

  invalidate(): void { this.image?.invalidate() }
  dispose(): void { this.read.abort() }
}

function isPictureLine(line: string): boolean {
  return line.includes('\x1b_G') || line.includes('\x1b]1337;File=')
}

/** Inspect images without modifying their draft or sending a message. */
export function showImageViewer(
  tui: TUI, palette: Palette, sources: readonly ImageViewerSource[], index = 0, signal?: AbortSignal,
): Promise<void> {
  if (sources.length === 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let viewer: ImageViewer | undefined
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', finish)
      viewer?.dispose()
      handle?.hide()
      tui.requestRender()
      resolve()
    }
    try {
      viewer = new ImageViewer(tui, palette, sources, index, finish)
      handle = tui.showOverlay(viewer, { width: '90%', maxHeight: '85%', anchor: 'center' })
      handle.focus()
      bindAbort(signal, finish)
    } catch (error) {
      viewer?.dispose()
      handle?.hide()
      reject(error)
    }
  })
}
