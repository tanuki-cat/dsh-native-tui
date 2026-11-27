import { CURSOR_MARKER, Editor, matchesKey, renderFakeCursor, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type AutocompleteProvider, type Component, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import { PasteInput } from './paste-input.js'
import { selectedRow } from './selection-row.js'

// Header, spacing, waiting/status rows and one transcript row stay visible.
const COMPLETION_CHROME_ROWS = 9

export interface AttachmentPresentation {
  readonly labels: string
  readonly preview: readonly string[]
  readonly labelWidths?: readonly number[]
  readonly targets?: readonly AttachmentTarget[]
}

export interface AttachmentTarget {
  readonly index: number
  readonly row: number
  readonly column: number
  readonly width: number
  readonly height: number
}

const placeholderSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A grapheme wider than this is a pathological cluster (stacked combining marks). */
const MAX_GRAPHEME_WIDTH = 2

/** Zero-width space: breaks a pathological cluster into individually bounded graphemes. */
const ZERO_WIDTH_SPACE = '\u200B'

/** Only marks, joiners and variation selectors can stack into an over-wide cluster. */
const STACKABLE_GRAPHEME = /[\p{M}\u200D\uFE0F]/u

const PASTE_START = '\u001B[200~'
const PASTE_END = '\u001B[201~'

function splitFirstGrapheme(text: string): { readonly first: string; readonly rest: string } {
  if (text === '') return { first: '', rest: '' }
  const next = placeholderSegmenter.segment(text)[Symbol.iterator]().next()
  if (next.done) return { first: text.slice(0, 1), rest: text.slice(1) }
  return { first: next.value.segment, rest: text.slice(next.value.segment.length) }
}

/**
 * Break clusters that are wider than any sane cell into separate graphemes.
 *
 * pi-tui's `wordWrapLine` recurses forever when one grapheme is wider than the
 * layout width, so a single cluster of hundreds of combining marks crashes the
 * renderer on a normal terminal. Joining the cluster's code points with a
 * zero-width space keeps its bytes but gives the segmenter a break opportunity,
 * leaving each grapheme at most one column wide.
 * @param text - text about to enter the editor.
 * @returns text whose graphemes are individually bounded.
 */
function clampGraphemeWidths(text: string): string {
  if (!STACKABLE_GRAPHEME.test(text)) return text
  let result = ''
  let changed = false
  for (const { segment } of placeholderSegmenter.segment(text)) {
    if (visibleWidth(segment) <= MAX_GRAPHEME_WIDTH) {
      result += segment
      continue
    }
    changed = true
    result += Array.from(segment).join(ZERO_WIDTH_SPACE)
  }
  return changed ? result : text
}

/** A shaded native editor with a display-only prompt in its reserved padding. */
export class PromptEditor extends Editor {
  private bottomBorder = ''
  private nativeInputHeight = 0
  private inputEnd = 0
  private menuRows: number[] = []
  private renderedPadding = 0
  private attachmentRows = 0
  private attachmentColumns = 0
  private panelStart = 0
  private attachmentTargets: readonly AttachmentTarget[] = []
  private readonly pasteInput: PasteInput
  /**
   * Synchronous input dispatches in progress.
   *
   * A key reaches this editor from the terminal, from a host dialog that
   * forwards it here, or from the asynchronous paste drain. Only the last one
   * may hand the key back to the focused component: during a synchronous
   * dispatch the key is already travelling through the component that owns
   * focus, and forwarding it back would call that host from its own stack.
   */
  private inputDepth = 0
  /** Dialog component that forwards keys to this editor, when one hosts it. */
  private inputHost: Component | undefined
  attachmentPresentation?: (width: number, maxRows: number) => AttachmentPresentation | undefined
  onPaste?: (text: string) => string | Promise<string>
  onRemoveAttachment?: () => boolean
  onPreviewAttachment?: (index: number) => void
  placeholder = ''

  constructor(tui: TUI, theme: EditorTheme, private readonly highlightSuggestion = theme.selectList.selectedText,
    private readonly surface: (text: string) => string = text => text) {
    super(tui, theme, { paddingX: 2 })
    this.pasteInput = new PasteInput(text => this.onPaste?.(text) ?? text,
      data => this.handleNativeInput(data), () => tui.requestRender())
  }

  override handleInput(data: string): void {
    this.inputDepth += 1
    try {
      this.pasteInput.handleInput(data)
    }
    finally {
      this.inputDepth -= 1
    }
  }

  override setText(text: string): void {
    super.setText(clampGraphemeWidths(text))
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(clampGraphemeWidths(text))
  }

  /**
   * Declare the dialog that hosts this editor.
   *
   * A hosted editor is focused by its dialog; input sent to it has already
   * passed through that component, so a drained key must not bounce back.
   * @param component - hosting dialog, or undefined for a top-level editor.
   */
  hostInput(component: Component | undefined): void {
    this.inputHost = component
  }

  whenInputIdle(): Promise<void> { return this.pasteInput.whenIdle() }

  get isProcessingPaste(): boolean { return this.pasteInput.busy }

  deferInput(action: () => void): void { this.pasteInput.defer(action) }

  cancelPendingInput(): void { this.pasteInput.cancel() }

  /** Consume the imported image's marker without resetting native paste or cursor state. */
  consumeAttachmentPrefix(draft: string, cursor: { line: number; col: number }): void {
    const current = this.getCursor()
    if (this.getText() !== draft || current.line !== cursor.line || current.col !== cursor.col) return
    if (!/(?:^|\s)@$/u.test(this.getLines()[cursor.line]?.slice(0, cursor.col) ?? '')) return
    // Native Shift+Backspace bypasses the async input queue and keeps deletion undoable.
    super.handleInput('\x1b[127;2u')
    if (this.isShowingAutocomplete()) super.handleInput('\x1b')
  }

  private handleNativeInput(data: string): void {
    // Only an asynchronous paste drain hands a key to the focused component:
    // the user may have opened an overlay while an image import was running,
    // and the queued key belongs to that overlay. A synchronous dispatch is
    // already inside the focused host and must stay here.
    if (this.inputDepth === 0) {
      const focused = (this.tui as TUI & { getFocusedComponent?(): Component | null }).getFocusedComponent?.()
      if (focused != null && focused !== this && focused !== this.inputHost) {
        focused.handleInput?.(data)
        return
      }
    }
    if (matchesKey(data, 'alt+i') && this.onPreviewAttachment !== undefined) {
      this.onPreviewAttachment(0)
      return
    }
    if (this.getText() === '' && matchesKey(data, 'backspace') && this.onRemoveAttachment?.()) {
      this.tui.requestRender()
      return
    }
    super.handleInput(this.guardInput(data))
  }

  /** Prevent a pathological paste or candidate from entering as one over-wide grapheme. */
  private guardInput(data: string): string {
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      const body = data.slice(PASTE_START.length, -PASTE_END.length)
      const guarded = clampGraphemeWidths(body)
      return guarded === body ? data : PASTE_START + guarded + PASTE_END
    }
    if (data.length > 0 && data.charCodeAt(0) >= 32 && !data.includes('\u001B')) return clampGraphemeWidths(data)
    return data
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

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return super.renderTopBorder(width, hiddenLineCount).replaceAll('─', ' ')
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount).replaceAll('─', ' ')
    return this.bottomBorder
  }

  override render(width: number): string[] {
    const attachments = this.attachmentPresentation?.(width, Math.min(8, Math.max(0, Math.floor(this.tui.terminal.rows / 4))))
    const labelBudget = Math.max(0, Math.min(Math.floor(width / 2), width - 12))
    const inline = attachments !== undefined && labelBudget >= 10
    const labels = attachments === undefined ? '' : truncateToWidth(attachments.labels, inline ? labelBudget : width, '…')
    this.attachmentColumns = inline ? visibleWidth(labels) + 1 : 0
    const extra = attachments === undefined ? [] : [...attachments.preview, ...(inline ? [] : [labels])]
    this.attachmentRows = extra.length
    const lines = this.renderEditor(width - this.attachmentColumns, width, inline ? labels : '', attachments !== undefined)
    const insertAt = this.panelStart + 1
    this.attachmentTargets = (attachments?.targets ?? []).map(target => ({ ...target, row: insertAt + target.row }))
    let column = inline ? this.renderedPadding : 0
    for (const [index, labelWidth] of (attachments?.labelWidths ?? []).entries()) {
      const end = Math.min(column + labelWidth, (inline ? this.renderedPadding : 0) + visibleWidth(labels))
      if (end > column) this.attachmentTargets = [...this.attachmentTargets, {
        index, row: insertAt + (inline ? extra.length : attachments!.preview.length),
        column, width: end - column, height: 1,
      }]
      column += labelWidth + 1
    }
    lines.splice(insertAt, 0, ...extra.map(line => {
      // Protocol rows carry their own cell geometry and may include cursor movement.
      if (line.includes('\x1b_G') || line.includes('\x1b]1337;File=')) return line
      return this.surface(line + ' '.repeat(Math.max(0, width - visibleWidth(line))))
    }))
    return lines
  }

  private renderEditor(width: number, fullWidth: number, labels: string, hasAttachments: boolean): string[] {
    // Match the native padding clamp so cursor, wrapping, mouse and menus keep their offsets.
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)))
    const contentWidth = Math.max(1, width - padding * 2)
    const layoutWidth = Math.max(1, contentWidth - (padding > 0 ? 0 : 1))
    this.renderedPadding = padding
    this.menuRows = []
    // A grapheme wider than the layout makes pi-tui's wordWrapLine recurse on
    // itself. Such text cannot be laid out natively, so render a clipped view.
    const lines = this.hasOverwideGrapheme(layoutWidth)
      ? this.renderSafeEditor(width, padding, layoutWidth)
      : super.render(width)
    if (!hasAttachments && this.getText() === '' && this.placeholder !== '' && lines[1] !== undefined) {
      const available = Math.max(1, width - padding * 2)
      const hint = stripTerminalSequences(truncateToWidth(this.placeholder, available, ''))
      const { first, rest } = splitFirstGrapheme(hint)
      const body = this.focused ? CURSOR_MARKER + renderFakeCursor(first || ' ') + rest : hint
      lines[1] = ' '.repeat(padding) + this.borderColor(body) + ' '.repeat(Math.max(0, width - padding - visibleWidth(body)))
    }
    if (padding > 0 && lines[1] !== undefined) {
      lines[1] = this.borderColor('›'.padEnd(padding)) + (labels === '' ? '' : labels + ' ') + lines[1].slice(padding)
    }
    const bottom = lines.lastIndexOf(this.bottomBorder)
    this.inputEnd = bottom
    for (let index = 0; index <= bottom; index += 1) {
      const prefix = index === 1 ? '' : ' '.repeat(this.attachmentColumns)
      lines[index] = this.surface(prefix + lines[index]!)
    }
    this.panelStart = 0
    const cursor = this.getCursor()
    if (!this.isShowingAutocomplete() || !this.getLines()[cursor.line]?.startsWith('/')) return lines
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
    const suggestions = this.menuRows.map(index => this.renderSuggestion(menu[index]!, fullWidth, padding))
    this.panelStart = suggestions.length
    return [...suggestions, ...input]
  }

  /** Whether any grapheme in the draft exceeds the native layout width. */
  private hasOverwideGrapheme(layoutWidth: number): boolean {
    for (const line of this.getLines()) {
      if (visibleWidth(line) <= layoutWidth) continue
      for (const { segment } of placeholderSegmenter.segment(line)) {
        if (visibleWidth(segment) > layoutWidth) return true
      }
    }
    return false
  }

  /** Clipped stand-in for a native layout that would recurse on an over-wide grapheme. */
  private renderSafeEditor(width: number, padding: number, layoutWidth: number): string[] {
    const lines = [this.renderTopBorder(width, 0)]
    const logical = this.getLines()
    const cursor = this.getCursor()
    const maxRows = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3))
    const start = Math.min(Math.max(0, cursor.line - Math.floor(maxRows / 2)), Math.max(0, logical.length - maxRows))
    const visible = logical.slice(start, start + Math.max(1, maxRows))
    for (const [offset, line] of visible.entries()) {
      let body = line
      if (start + offset === cursor.line && this.focused) {
        const before = line.slice(0, cursor.col)
        const after = line.slice(cursor.col)
        const at = splitFirstGrapheme(after).first || ' '
        body = before + CURSOR_MARKER + renderFakeCursor(at) + after.slice(at.length)
      }
      const clipped = truncateToWidth(body, layoutWidth, '…')
      lines.push(' '.repeat(padding) + clipped + ' '.repeat(Math.max(0, width - padding - visibleWidth(clipped))))
    }
    lines.push(this.renderBottomBorder(width, 0))
    return lines
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button === 'left') {
      const target = this.attachmentTargets.find(target => event.y >= target.row && event.y < target.row + target.height
        && event.x >= target.column && event.x < target.column + target.width)
      if (target !== undefined && this.onPreviewAttachment !== undefined) {
        this.onPreviewAttachment(target.index)
        return { handled: true, focus: false, render: false }
      }
    }
    const previewStart = this.panelStart + 1
    if (event.y >= previewStart && event.y < previewStart + this.attachmentRows) return undefined
    if (event.y >= previewStart) event = { ...event, y: event.y - this.attachmentRows }
    if (event.y >= this.panelStart && event.y <= this.panelStart + this.inputEnd) event = { ...event,
      x: Math.max(0, event.x - this.attachmentColumns), width: event.width - this.attachmentColumns,
    }
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
    return selected ? selectedRow(row, width, this.highlightSuggestion) : row
  }
}
