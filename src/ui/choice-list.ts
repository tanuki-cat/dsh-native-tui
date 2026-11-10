import { SelectList } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { selectTheme, type Palette } from './theme.js'
import { selectionRows } from './selection-row.js'

/** External labels stay plain; only the UI assigns a semantic badge color. */
export interface ChoiceItem {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly badge?: { readonly text: string; readonly tone: 'neutral' | 'info' | 'success' | 'warning' }
}

/** Native navigation and filtering with paint-time badges and a shared selection row. */
export class ChoiceList extends SelectList {
  private readonly updateLabels: () => void

  constructor(items: readonly ChoiceItem[], maxVisible: number, private readonly palette: Palette) {
    const singleLine = (text: string): string => sanitizeTerminalText(text).replace(/[\r\n\t]/gu, ' ')
    const native = items.map(item => ({ value: item.value, label: singleLine(item.label),
      ...(item.description === undefined ? {} : { description: singleLine(item.description) }),
    }))
    super(native, maxVisible, { ...selectTheme(palette), selectedText: text => text })
    this.updateLabels = () => {
      const colors = { neutral: palette.dim, info: palette.accent, success: palette.success, warning: palette.warning }
      items.forEach((item, index) => {
        native[index]!.label = singleLine(item.label) + (item.badge === undefined ? ''
          : ' ' + colors[item.badge.tone]('[' + singleLine(item.badge.text) + ']'))
      })
    }
    this.updateLabels()
  }

  override render(width: number): string[] {
    this.updateLabels()
    return selectionRows(super.render(width), width, this.palette.autocompleteSelection)
  }
}
