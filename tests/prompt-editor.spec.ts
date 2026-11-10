import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'

const plainTheme = editorTheme(createPalette('plain'))
function createEditor() {
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() }
  const editor = new PromptEditor(tui as never, plainTheme)
  editor.focused = true
  return editor
}
const withoutCursor = (text: string) => text.replace(CURSOR_MARKER, '')
const cursorColumn = (lines: string[]): number => {
  const line = lines.find(line => line.includes(CURSOR_MARKER))
  if (line === undefined) throw new Error('expected a focused editor cursor')
  return visibleWidth(line.slice(0, line.indexOf(CURSOR_MARKER)))
}

describe('PromptEditor', () => {
  it('shows an empty-input hint without changing the draft, cursor, submission or mouse target', () => {
    const editor = createEditor(), submitted = vi.fn()
    editor.placeholder = 'Ask DeepSeek Harness to do anything'
    editor.onSubmit = submitted
    expect(stripTerminalSequences(withoutCursor(editor.render(60)[1]!))).toContain('› Ask DeepSeek Harness to do anything')
    expect(cursorColumn(editor.render(60))).toBe(2)
    expect(editor.getText()).toBe('')
    editor.handleMouse({ type: 'click', button: 'left', x: 15, y: 1, width: 60, height: 3 } as never)
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 })
    editor.handleInput('\r')
    expect(submitted).toHaveBeenCalledWith('')
    editor.handleInput('hello')
    expect(withoutCursor(editor.render(60)[1]!)).toContain('› hello')
    expect(editor.render(60).join('\n')).not.toContain('Ask DeepSeek')
    editor.setText('')
    expect(stripTerminalSequences(editor.render(60).join('\n'))).toContain('Ask DeepSeek')
  })

  it.each([1, 2, 8, 20, 80])('bounds the empty-input hint to %i columns', width => {
    const editor = createEditor()
    editor.placeholder = 'Ask DeepSeek Harness to do anything'
    expect(editor.render(width).every(line => visibleWidth(withoutCursor(line)) <= width)).toBe(true)
    expect(cursorColumn(editor.render(width))).toBeLessThan(width)
    expect(editor.getText()).toBe('')
  })
  it.each(['dark', 'light', 'plain'] as const)('shades only the %s input panel and leaves completion selection distinct', async theme => {
    const palette = createPalette(theme)
    const editor = new PromptEditor({ terminal: { rows: 30 }, requestRender: vi.fn() } as never,
      editorTheme(palette), palette.autocompleteSelection, palette.dialogBand)
    editor.focused = true
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'help' }], process.cwd(), null))
    editor.handleInput('/')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
    const lines = editor.render(40)
    const prompt = lines.findLastIndex(line => stripTerminalSequences(line).startsWith('› '))
    expect(stripTerminalSequences(lines[prompt - 1]!)).toBe(' '.repeat(40))
    expect(stripTerminalSequences(lines[prompt + 1]!)).toBe(' '.repeat(40))
    expect(lines.join('\n')).not.toContain('─')
    expect(lines.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
    if (theme === 'plain') expect(lines.join('\n')).not.toContain('\x1b[48;')
    else {
      const code = theme === 'dark' ? '48;5;236' : '48;5;255'
      expect(lines[prompt]).toContain(code)
      expect(lines[prompt - 1]).toContain(code)
      expect(lines[prompt + 1]).toContain(code)
      expect(lines[0]).not.toContain(code)
    }
  })
  it('shows a prompt in the empty editor inside blank full-width spacing rows', () => {
    const editor = createEditor()
    const lines = editor.render(40)
    expect(lines[0]).toBe(' '.repeat(40))
    expect(lines[1]?.startsWith('› ')).toBe(true)
    expect(lines.at(-1)).toBe(' '.repeat(40))
    expect(cursorColumn(lines)).toBe(2)
    expect(editor.getText()).toBe('')
  })

  it('keeps typed text and submission free of the display prompt', () => {
    const editor = createEditor()
    const onSubmit = vi.fn()
    editor.onSubmit = onSubmit
    editor.handleInput('hello')
    expect(withoutCursor(editor.render(40)[1]!)).toContain('› hello')
    expect(editor.getText()).toBe('hello')
    expect(cursorColumn(editor.render(40))).toBe(7)
    editor.handleInput('\r')
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('reserves the same two columns for Unicode cursor placement', () => {
    const editor = createEditor()
    const text = '你好😀'
    editor.setText(text)
    expect(cursorColumn(editor.render(40))).toBe(2 + visibleWidth(text))
    expect(editor.getText()).toBe(text)
  })

  it('indents continuation rows without repeating the prompt and preserves wrap navigation', () => {
    const editor = createEditor()
    editor.setText('abcdefghijklmnop\n你好 next line')
    const original = editor.getText()
    const lines = editor.render(12)
    expect(lines[1]?.startsWith('› ')).toBe(true)
    for (const line of lines.slice(2, -1)) expect(line.startsWith('  ')).toBe(true)
    expect(lines.filter(line => line.startsWith('› '))).toHaveLength(1)
    expect(lines.every(line => visibleWidth(withoutCursor(line)) <= 12)).toBe(true)
    editor.handleInput('\x1b[A')
    expect(editor.getText()).toBe(original)
    expect(cursorColumn(editor.render(12))).toBeGreaterThanOrEqual(2)
  })

  it.each([2, 3, 4, 5, 8, 20, 80])('keeps input intact and fits a %i-column terminal', width => {
    const editor = createEditor()
    editor.setText('abcdef')
    const lines = editor.render(width)
    expect(lines.every(line => visibleWidth(withoutCursor(line)) <= width)).toBe(true)
    expect(editor.getText()).toBe('abcdef')
    expect(cursorColumn(lines)).toBeLessThan(width)
  })

  it('defers to native rendering when a single-column terminal has no room for a gutter', () => {
    const editor = createEditor()
    editor.setText('abcdef')
    const native = Editor.prototype.render.call(editor, 1)
    expect(editor.render(1)).toEqual(native)
    expect(editor.getText()).toBe('abcdef')
  })

  it('keeps the prompt visible when a multiline draft scrolls', () => {
    const editor = createEditor()
    editor.setText(Array.from({ length: 30 }, (_, index) => 'row ' + index).join('\n'))
    const lines = editor.render(40)
    expect(lines[0]).toContain('↑')
    expect(lines[1]?.startsWith('› ')).toBe(true)
    expect(lines.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
  })

  it('uses native mouse coordinates in the gutter and text', () => {
    const editor = createEditor()
    editor.setText('hello')
    editor.render(40)
    editor.handleMouse({ type: 'click', button: 'left', x: 4, y: 1, width: 40, height: 3 } as never)
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 })
    editor.handleMouse({ type: 'click', button: 'left', x: 0, y: 1, width: 40, height: 3 } as never)
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 })
    expect(cursorColumn(editor.render(40))).toBe(2)
  })

  it('keeps native input geometry and insertion while placing the slash menu above it', async () => {
    const editor = createEditor()
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'help', description: 'Show help' }], process.cwd(), null))
    editor.handleInput('/')
    await vi.waitFor(() => { expect(editor.isShowingAutocomplete()).toBe(true) })
    const native = Editor.prototype.render.call(editor, 40)
    const decorated = editor.render(40)
    expect(decorated[0]).toContain('› help')
    const input = decorated.slice(native.length - 3)
    expect(input[0]).toBe(native[0])
    expect(input[1]).toBe('› ' + native[1]!.slice(2))
    expect(input[2]).toBe(native[2])
    expect(decorated.join('\n')).toContain('help')
    editor.handleInput('\t')
    expect(editor.getText()).toBe('/help ')
    expect(editor.getText()).not.toContain('>')
  })
})
