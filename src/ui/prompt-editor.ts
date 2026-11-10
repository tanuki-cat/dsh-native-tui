import { Editor, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type AutocompleteProvider, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import { PasteInput } from './paste-input.js'

// Header, dividers, waiting/status rows and one transcript row stay visible.
const COMPLETION_CHROME_ROWS = 9

/** A native editor with a display-only prompt in its reserved left padding. */
export class PromptEditor extends Editor {
  private bottomBorder = ''
  private nativeInputHeight = 0
  private menuRows: number[] = []
  private renderedPadding = 0
  private attachmentRows = 0
  private readonly pasteInput: PasteInput
  attachmentRow?: (width: number) => string | undefined
  onPaste?: (text: string) => string | Promise<string>
  onRemoveAttachment?: () => boolean

  constructor(tui: TUI, theme: EditorTheme, private readonly highlightSuggestion = theme.selectList.selectedText) {
    super(tui, theme, { paddingX: 2 })
    this.pasteInput = new PasteInput(text => this.onPaste?.(text) ?? text,
      data => this.handleNativeInput(data), () => tui.requestRender())
  }

  override handleInput(data: string): void {
    this.pasteInput.handleInput(data)
  }

  whenInputIdle(): Promise<void> { return this.pasteInput.whenIdle() }

  get isProcessingPaste(): boolean { return this.pasteInput.busy }

  deferInput(action: () => void): void { this.pasteInput.defer(action) }

  cancelPendingInput(): void { this.pasteInput.cancel() }

  private handleNativeInput(data: string): void {
    if (this.getText() === '' && matchesKey(data, 'backspace') && this.onRemoveAttachment?.()) {
      this.tui.requestRender()
      return
    }
    super.handleInput(data)
  }

  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider({
      triggerCharacters: provider.triggerCharacters,
      getSuggestions: (lines, row, col, options) => {
        this.setAutocompleteMaxVisible(lines[row]?.startsWith('/') ? 8 : 5)
        return provider.getSuggestions(lines, row, col, options)
      },
      applyCompletion: (...args) => provider.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) => provider.shouldTriggerFileCompletion?.(...args) ?? true,
    })
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount)
    return this.bottomBorder
  }

  override render(width: number): string[] {
    const row = this.attachmentRow?.(width)
    this.attachmentRows = row === undefined ? 0 : 1
    const lines = this.renderEditor(width)
    return row === undefined ? lines : [row, ...lines]
  }

  private renderEditor(width: number): string[] {
    const lines = super.render(width)
    // Match the native padding clamp so cursor, wrapping, mouse and menus keep their offsets.
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)))
    this.renderedPadding = padding
    this.menuRows = []
    if (padding > 0 && lines[1] !== undefined) {
      lines[1] = this.borderColor('>'.padEnd(padding)) + lines[1].slice(padding)
    }
    const cursor = this.getCursor()
    if (!this.isShowingAutocomplete() || !this.getLines()[cursor.line]?.startsWith('/')) return lines
    const bottom = lines.lastIndexOf(this.bottomBorder)
    if (bottom < 1 || bottom === lines.length - 1) return lines
    const input = lines.slice(0, bottom + 1)
    const menu = lines.slice(bottom + 1)
    this.nativeInputHeight = input.length
    const hasScrollInfo = /^\s*\(\d+\/\d+\)\s*$/u.test(stripTerminalSequences(menu.at(-1)!))
    const itemCount = menu.length - (hasScrollInfo ? 1 : 0)
    const budget = Math.max(1, this.tui.terminal.rows - input.length - COMPLETION_CHROME_ROWS - this.attachmentRows)
    const keepScrollInfo = hasScrollInfo && budget > 1
    const itemBudget = Math.max(1, budget - (keepScrollInfo ? 1 : 0))
    const selected = Math.max(0, menu.findIndex(line => stripTerminalSequences(line).slice(padding).startsWith('→ ')))
    const start = Math.max(0, Math.min(selected - Math.floor(itemBudget / 2), itemCount - itemBudget))
    this.menuRows = Array.from({ length: Math.min(itemBudget, itemCount) }, (_, index) => start + index)
    if (keepScrollInfo) this.menuRows.push(menu.length - 1)
    const suggestions = this.menuRows.map(index => this.renderSuggestion(menu[index]!, width, padding))
    return [...suggestions, ...input]
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < this.attachmentRows) return undefined
    event = { ...event, y: event.y - this.attachmentRows }
    if (this.menuRows.length === 0) return super.handleMouse(event)
    const nativeRow = this.menuRows[event.y]
    return super.handleMouse({ ...event,
      x: nativeRow === undefined ? event.x : event.x + this.renderedPadding,
      y: nativeRow === undefined ? event.y - this.menuRows.length : this.nativeInputHeight + nativeRow,
    })
  }

  private renderSuggestion(line: string, width: number, padding: number): string {
    const plain = stripTerminalSequences(line).slice(padding)
    const selected = plain.startsWith('→ ')
    const body = selected ? '› ' + plain.slice(2).trimEnd()
      : sliceByColumn(line, padding, Math.max(1, width - padding * 2)).trimEnd()
    const clipped = truncateToWidth(body, Math.max(1, width), '')
    const row = clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
    return selected ? this.highlightSuggestion(row) : row
  }
}
