import { Editor, type EditorTheme, type TUI } from '@earendil-works/pi-tui'

/** A native editor with a display-only prompt in its reserved left padding. */
export class PromptEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme, { paddingX: 2 })
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    // Match the native padding clamp so cursor, wrapping, mouse and menus keep their offsets.
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)))
    if (padding > 0 && lines[1] !== undefined) {
      lines[1] = this.borderColor('>'.padEnd(padding)) + lines[1].slice(padding)
    }
    return lines
  }
}
