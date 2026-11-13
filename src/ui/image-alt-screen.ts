import { TuiAltScreen, getCapabilities, setCapabilities, visibleWidth, type TuiStopOptions } from '@earendil-works/pi-tui'

const END_SYNC = '\x1b[?2026l'
const ITERM_IMAGE = /(?:\x1b\[(\d+)A)?(\x1b\]1337;File=[^\x07\x1b]*(?:\x07|\x1b\\))/gu

interface Picture {
  readonly top: number
  readonly bottom: number
  readonly column: number
  readonly sequence: string
}

interface PictureRow {
  readonly line: string
  readonly pictures: readonly Picture[]
}

/** Locate pi-tui's iTerm2 anchors without decoding or changing the image bytes. */
function pictures(line: string, bottom: number, width: number, height: number): Picture[] {
  const result: Picture[] = []
  for (const match of line.matchAll(ITERM_IMAGE)) {
    const top = bottom - Number(match[1] ?? 0)
    const column = visibleWidth(line.slice(0, match.index))
    const columns = Number(/(?:;|=)width=(\d+)(?:;|:)/u.exec(match[2]!)?.[1])
    // Leave a row below the image so iTerm2's implicit cursor advance cannot scroll the viewport.
    if (top < 0 || bottom >= height - 1 || !Number.isSafeInteger(columns) || columns <= 0 || column + columns > width) continue
    result.push({ top, bottom, column,
      sequence: match[2]!.replace(/;height=auto(?=;|:)/u, ';height=' + String(bottom - top + 1)) })
  }
  return result
}

/** Keep native fullscreen layout while painting iTerm2 images after every intersecting text write. */
export class ImageAltScreen extends TuiAltScreen {
  private itermImages = false
  private pictureRows = new Map<number, PictureRow>()
  private pictureGeometry = ''

  protected override beforeTerminalStart(): void {
    const capabilities = getCapabilities()
    super.beforeTerminalStart()
    this.pictureRows.clear()
    this.pictureGeometry = ''
    this.itermImages = capabilities.images === 'iterm2'
    if (this.itermImages) setCapabilities(capabilities)
  }

  protected override afterTerminalStop(options: TuiStopOptions): void {
    try { super.afterTerminalStop(options) }
    finally { this.itermImages = false; this.pictureRows.clear() }
  }

  private framePictures(screen: readonly string[]): Picture[] {
    const { columns, rows } = this.terminal
    const geometry = columns + ':' + rows
    if (this.pictureGeometry !== geometry) this.pictureRows.clear()
    const next = new Map<number, PictureRow>()
    const result: Picture[] = []
    for (const [row, line] of screen.entries()) {
      if (!line.includes('\x1b]1337;File=')) continue
      const cached = this.pictureRows.get(row)
      const entry = cached?.line === line ? cached : { line, pictures: pictures(line, row, columns, rows) }
      next.set(row, entry)
      result.push(...entry.pictures)
    }
    this.pictureRows = next
    this.pictureGeometry = geometry
    return result
  }

  protected override doRender(): void {
    if (!this.itermImages) { super.doRender(); return }
    const before = this.getScreenLines()
    const terminal = this.terminal
    const write = terminal.write
    let buffer = ''
    terminal.write = data => { buffer += data }
    try { super.doRender() }
    finally { terminal.write = write }
    if (buffer === '') return
    const screen = this.getScreenLines()
    const cleared = buffer.includes('\x1b[2J') || buffer.includes('\x1b[3J')
    const redraw = this.framePictures(screen).filter(picture => {
      if (cleared) return true
      for (let row = picture.top; row <= picture.bottom; row += 1) {
        if (screen[row] !== before[row]) return true
      }
      return false
    })
    // Strip the native relative image write; its reserved rows still receive normal clears and text.
    buffer = buffer.replace(ITERM_IMAGE, '')
    if (redraw.length > 0) {
      const drawing = '\x1b7' + redraw.map(picture =>
        '\x1b[' + String(picture.top + 1) + ';' + String(picture.column + 1) + 'H' + picture.sequence).join('') + '\x1b8'
      const end = buffer.lastIndexOf(END_SYNC)
      buffer = end < 0 ? buffer + drawing : buffer.slice(0, end) + drawing + buffer.slice(end)
    }
    write.call(terminal, buffer)
  }
}
