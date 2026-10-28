import { Text, truncateToWidth, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from './theme.js'

type Frame = (lines: readonly string[], width: number, palette: Palette) => string[]

/** Full request viewer with visual-row paging, resize-aware bounds, and owned cancellation. */
export function showApprovalDetails(tui: TUI, palette: Palette, text: string, frame: Frame, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { resolve(); return }
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let settled = false, offset = 0, page = 1, total = 0, lastWidth = -1
    let lines: string[] = []
    const body = new Text(text, 0, 0)
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', finish)
      handle?.hide()
      resolve()
    }
    const component = {
      render(width: number): string[] {
        const inner = Math.max(1, width - 4)
        if (width !== lastWidth) { lines = body.render(inner); lastWidth = width }
        total = lines.length
        const rows = tui.terminal?.rows ?? 30
        page = Math.max(1, Math.floor(rows * 0.8) - 4)
        offset = Math.min(offset, Math.max(0, total - page))
        const hint = 'Esc closes · ↑/↓ PgUp/PgDn · ' + (offset + 1) + '–' + Math.min(total, offset + page) + '/' + total
        return frame([
          palette.bold(truncateToWidth('Approval request details', inner)),
          ...lines.slice(offset, offset + page),
          palette.dim(truncateToWidth(hint, inner)),
        ], width, palette)
      },
      handleInput(data: string): void {
        if (data === '\x1b') { finish(); return }
        if (data === '\x1b[A') offset -= 1
        else if (data === '\x1b[B') offset += 1
        else if (data === '\x1b[5~') offset -= page
        else if (data === '\x1b[6~') offset += page
        else return
        offset = Math.max(0, Math.min(offset, Math.max(0, total - page)))
        tui.requestRender()
      },
      invalidate(): void { lastWidth = -1; body.invalidate() },
    }
    try {
      handle = tui.showOverlay(component, { width: 100, maxHeight: '80%', anchor: 'center' })
      handle.focus()
      signal?.addEventListener('abort', finish, { once: true })
      if (Boolean(signal?.aborted)) finish()
    } catch (error) { signal?.removeEventListener('abort', finish); handle?.hide(); reject(error) }
  })
}
