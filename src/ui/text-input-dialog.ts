import {
  CURSOR_MARKER,
  Input,
  Text,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { dialogFrame } from './dialog-frame.js'
import { graphemesOf } from './grapheme-preview.js'
import type { Palette } from './theme.js'

/** Single-line input wrapper that owns its title and key hint. */
export class TextInputDialog implements Component {
  readonly input: Input
  constructor(
    private readonly title: string,
    private readonly placeholder: string,
    private readonly hint: string,
    private readonly palette: Palette,
    initialValue?: string,
    private readonly secret = false,
  ) {
    this.input = new Input({ prompt: '› ', placeholder })
    if (initialValue !== undefined) {
      // Host settings are untrusted data: escape sequences there would reach the
      // terminal through the Input, and a single-line field cannot hold breaks.
      this.input.setValue(sanitizeTerminalText(initialValue).replace(/[\r\n\t]/gu, ' '))
      // setValue leaves the cursor before the old text; a prefilled field should
      // open at its end so typing extends the value instead of prepending to it.
      this.input.handleInput('\x05')
    }
    this.input.focused = true
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4)
    return dialogFrame([
      ...new Text(sanitizeTerminalText(this.title), 0, 0).render(inner),
      '',
      ...(this.secret ? this.renderMasked(inner) : this.input.render(inner)),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(inner),
    ], width, this.palette)
  }

  /** Echo one `*` per grapheme; the native `Input` keeps the real value and cursor. */
  private renderMasked(width: number): string[] {
    const prompt = '› '
    const available = Math.max(0, width - visibleWidth(prompt))
    if (available === 0) return [truncateToWidth(prompt, Math.max(0, width), '')]
    const value = this.input.getValue()
    const marker = this.input.focused ? CURSOR_MARKER : ''
    if (value === '') {
      const hint = truncateToWidth(sanitizeTerminalText(this.placeholder), available, '')
      const first = graphemesOf(hint)[0] ?? ' '
      const body = marker + renderFakeCursor(first) + hint.slice(first.length)
      return [prompt + body + ' '.repeat(Math.max(0, available - visibleWidth(body)))]
    }
    const cursor = this.input.focused ? renderFakeCursor(' ') : ''
    const room = Math.max(0, available - (cursor === '' ? 0 : 1))
    const stars = '*'.repeat(Math.min(graphemesOf(value).length, room))
    const body = stars + marker + cursor
    return [prompt + body + ' '.repeat(Math.max(0, available - visibleWidth(body)))]
  }

  handleInput(data: string): void { this.input.handleInput(data) }
  invalidate(): void { this.input.invalidate() }
}
