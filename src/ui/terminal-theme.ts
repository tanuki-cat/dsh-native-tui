import { getTerminalColorMode, type TerminalColorMode, type TerminalColors, type TUI } from '@earendil-works/pi-tui'
import type { Theme } from '../config.js'
import { createPalette, type Palette } from './theme.js'

const STYLE_KEYS = ['dim', 'bold', 'italic', 'underline', 'accent', 'brand', 'success', 'warning', 'error',
  'model', 'workspace', 'ready', 'userBand', 'toolBand', 'thinkingBand', 'diffAddBand', 'diffRemoveBand',
  'dialogBand', 'dialogBorder', 'autocompleteSelection', 'preset'] as const
type StyleKey = typeof STYLE_KEYS[number]

/** Stable style functions let mounted components follow late terminal color replies. */
export function createTerminalTheme(theme: Theme, colorMode: TerminalColorMode = getTerminalColorMode()) {
  let colors: TerminalColors = {}
  let current = createPalette(theme, colors, colorMode)
  let disposed = false
  let queryId = 0
  let release: (() => void) | undefined
  let terminal: TUI | undefined
  const styles = Object.fromEntries(STYLE_KEYS.map(key => [key, (text: string) => current[key](text)])) as Record<StyleKey, (text: string) => string>
  const palette: Palette = {
    ...current, ...styles,
    reasoning: effort => text => current.reasoning(effort)(text),
    context: (percent, threshold) => text => current.context(percent, threshold)(text),
    contextBucket: bucket => text => current.contextBucket(bucket)(text),
  }
  const update = (next: TerminalColors): boolean => {
    const merged = {
      foreground: next.foreground ?? colors.foreground,
      background: next.background ?? colors.background,
    }
    if (disposed || theme === 'plain' || JSON.stringify(merged) === JSON.stringify(colors)) return false
    colors = merged
    current = createPalette(theme, colors, colorMode)
    return true
  }
  return {
    palette, update,
    connect(tui: TUI, repaint: () => void): void {
      if (theme === 'plain' || disposed || terminal !== undefined) return
      terminal = tui
      const query = (): void => {
        const id = ++queryId
        const apply = (reply: TerminalColors): void => { if (id === queryId && update(reply)) repaint() }
        void tui.queryTerminalColors({ timeoutMs: 150, onLateReply: apply }).then(apply).catch(() => {})
      }
      release = tui.onTerminalColorSchemeChange(query)
      tui.setTerminalColorSchemeNotifications(true)
      query()
    },
    dispose(): void {
      disposed = true
      release?.()
      terminal?.setTerminalColorSchemeNotifications(false)
    },
  }
}
