import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { TuiAutocompleteProvider, type CommandSuggestion } from '../src/ui/autocomplete.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'

const commands: CommandSuggestion[] = [
  { name: 'model', description: 'Choose the model' },
  { name: 'fast', description: 'Change speed' },
  { name: 'presets', description: 'Choose a preset' },
  { name: 'daybreak', description: 'Learn more' },
  { name: 'ide', description: 'Include IDE context' },
  { name: 'permissions', description: 'Choose permissions' },
  { name: 'keymap', description: 'Remap shortcuts' },
  { name: 'vim', description: 'Toggle Vim mode' },
]

function harness(theme: 'plain' | 'dark' | 'light' = 'plain', items = commands) {
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() }
  const palette = createPalette(theme)
  const editor = new PromptEditor(tui as never, editorTheme(palette), palette.autocompleteSelection)
  editor.focused = true
  editor.setAutocompleteProvider(new TuiAutocompleteProvider({
    getAgent: () => ({} as never), getCommands: () => items, getSkills: async () => [],
    getFileReferences: () => undefined, getSessionReferences: () => undefined,
  }))
  return { tui, editor }
}
const clean = (line: string) => stripTerminalSequences(line).replace(CURSOR_MARKER, '')
const displayed = (editor: PromptEditor, width = 80) => editor.render(width).map(clean)
async function open(editor: PromptEditor, text = '/') {
  editor.handleInput(text)
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true))
}
const mouse = (overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: 'click', button: 'left', x: 4, y: 0, screenX: 4, screenY: 0, width: 80, height: 20,
  shift: false, alt: false, ctrl: false, ...overrides,
})

describe('upward command completion', () => {
  it('puts eight aligned command rows above the editor with one hardware cursor', async () => {
    const { editor } = harness()
    await open(editor)
    const rendered = editor.render(80), lines = rendered.map(clean)
    expect(lines[0]?.trimEnd()).toBe('› /model        Choose the model')
    expect(lines[7]).toContain('/vim')
    expect(lines[8]).toBe('─'.repeat(80))
    expect(lines[9]).toContain('> /')
    expect(lines.at(-1)).toBe('─'.repeat(80))
    const columns = commands.map((command, index) => lines[index]!.indexOf(command.description!))
    expect(new Set(columns).size).toBe(1)
    expect(rendered.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
    expect(rendered[9]).toContain(CURSOR_MARKER)
    expect(editor.getText()).toBe('/')
  })

  it.each(['dark', 'light'] as const)('fills the selected row with a blue band in %s', async theme => {
    const { editor } = harness(theme)
    await open(editor)
    const lines = editor.render(80)
    expect(lines[0]).toContain('\x1b[48;5;75;30m')
    expect(lines[0]?.endsWith('\x1b[39;49m')).toBe(true)
    expect(visibleWidth(lines[0]!)).toBe(80)
    expect(lines[1]).not.toContain('48;5;75')
    expect(lines.find(line => clean(line).startsWith('> '))).not.toContain('48;5;75')
  })

  it('keeps plain command rows free of ANSI', async () => {
    const { editor } = harness()
    await open(editor)
    expect(editor.render(80).slice(0, 8).every(line => !line.includes('\x1b'))).toBe(true)
  })

  it('keeps arrow selection, Tab insertion and Enter submission native', async () => {
    const { editor } = harness()
    const onSubmit = vi.fn()
    editor.onSubmit = onSubmit
    await open(editor)
    editor.handleInput('\x1b[B')
    expect(displayed(editor)[1]).toContain('› /fast')
    editor.handleInput('\t')
    expect(editor.getText()).toBe('/fast')
    expect(editor.isShowingAutocomplete()).toBe(false)
    expect(displayed(editor)[1]).toContain('> /fast')
    editor.handleInput('\r')
    expect(onSubmit).toHaveBeenCalledWith('/fast')
  })

  it('moves subcommand suggestions above the editor without changing their replacement prefix', async () => {
    const { editor } = harness('plain', [{ name: 'provider', subcommands: [
      { name: 'add', hint: '<route>', description: 'Add a route' },
      { name: 'list', description: 'List routes' },
    ] }])
    await open(editor, '/provider ')
    expect(displayed(editor)[0]).toContain('› add <route>')
    editor.handleInput('\t')
    expect(editor.getText()).toBe('/provider add')
  })

  it.each([1, 8, 20, 40])('bounds Unicode command rows to %i columns', async width => {
    const { editor } = harness('plain', [{ name: '中文😀', description: '说明👩‍💻'.repeat(12) }])
    await open(editor)
    const lines = editor.render(width)
    const border = lines.findIndex(line => clean(line) === '─'.repeat(width))
    expect(border).toBeGreaterThan(0)
    expect(lines.slice(0, border).every(line => visibleWidth(line) <= width)).toBe(true)
    expect(editor.getText()).toBe('/')
    expect(lines.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
  })

  it('keeps selection visible in a short terminal after scrolling and resizing', async () => {
    const { editor, tui } = harness('plain', Array.from({ length: 20 }, (_, index) => ({ name: 'command-' + index })))
    await open(editor)
    tui.terminal.rows = 16
    for (let index = 0; index < 13; index += 1) editor.handleInput('\x1b[B')
    const lines = displayed(editor)
    const prompt = lines.findIndex(line => line.startsWith('> '))
    expect(lines.slice(0, prompt - 1).some(line => line.includes('› /command-13'))).toBe(true)
    expect(prompt).toBeLessThanOrEqual(5)
    expect(lines.slice(0, prompt - 1).some(line => line.includes('(14/20)'))).toBe(true)
  })

  it('maps menu clicks and input cursor placement to their new rows', async () => {
    const { editor } = harness()
    await open(editor)
    editor.render(80)
    editor.handleMouse(mouse({ y: 1 }))
    expect(editor.getText()).toBe('/fast')
    expect(editor.isShowingAutocomplete()).toBe(false)
    editor.setText('hello')
    editor.render(80)
    editor.handleMouse(mouse({ y: 1, x: 4 }))
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 })
  })

  it('maps a cropped menu row back to the selected native item', async () => {
    const { editor, tui } = harness('plain', Array.from({ length: 20 }, (_, index) => ({ name: 'command-' + index })))
    await open(editor)
    tui.terminal.rows = 16
    for (let index = 0; index < 13; index += 1) editor.handleInput('\x1b[B')
    const selected = displayed(editor).findIndex(line => line.startsWith('› /command-13'))
    expect(selected).toBeGreaterThanOrEqual(0)
    editor.handleMouse(mouse({ y: selected }))
    expect(editor.getText()).toBe('/command-13')
  })

  it('refilters the upward menu and submits the selected command on Enter', async () => {
    const { editor } = harness()
    const onSubmit = vi.fn()
    editor.onSubmit = onSubmit
    await open(editor)
    editor.handleInput('mod')
    await vi.waitFor(() => expect(displayed(editor)[1]).toBe('─'.repeat(80)))
    expect(displayed(editor)[0]).toContain('› /model')
    editor.handleInput('\r')
    expect(onSubmit).toHaveBeenCalledWith('/model')
    expect(editor.isShowingAutocomplete()).toBe(false)
  })

  it('maps mouse input rows and wheel selection while the menu stays open', async () => {
    const { editor } = harness()
    await open(editor)
    const lines = displayed(editor)
    const prompt = lines.findIndex(line => line.startsWith('> '))
    editor.handleMouse(mouse({ y: prompt, x: 3 }))
    expect(editor.getCursor()).toEqual({ line: 0, col: 1 })
    editor.handleMouse(mouse({ type: 'wheel', wheelDelta: 1, y: 0 }))
    expect(displayed(editor)[1]).toContain('› /fast')
  })

  it('restores native geometry after cancellation and when there are no matches', async () => {
    const { editor } = harness()
    await open(editor)
    editor.render(80)
    editor.handleInput('\x1b')
    expect(displayed(editor)[0]).toBe('─'.repeat(80))
    expect(editor.getText()).toBe('/')
    editor.handleInput('unknown')
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(false))
    expect(displayed(editor)[1]).toContain('> /unknown')
  })

  it('leaves @file suggestions below the editor', async () => {
    const { editor } = harness()
    editor.setAutocompleteProvider({ triggerCharacters: ['@'],
      getSuggestions: async () => ({ prefix: '@', items: [{ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' }] }),
      applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
    })
    await open(editor, '@')
    const lines = displayed(editor)
    expect(lines[0]).toBe('─'.repeat(80))
    expect(lines[1]).toContain('> @')
    expect(lines[3]).toContain('a.ts')
    editor.handleInput('\t')
    expect(editor.getText()).toBe('@src/a.ts')
  })

  it('keeps the native five-item limit when switching from commands to file completion', async () => {
    const { editor } = harness()
    await open(editor)
    expect(editor.getAutocompleteMaxVisible()).toBe(8)
    editor.setText('')
    editor.setAutocompleteProvider({ triggerCharacters: ['@'],
      getSuggestions: async () => ({ prefix: '@', items: Array.from({ length: 12 }, (_, index) => ({
        value: '@src/file-' + index, label: 'file-' + index,
      })) }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    })
    await open(editor, '@')
    expect(editor.getAutocompleteMaxVisible()).toBe(5)
    const lines = displayed(editor)
    expect(lines.filter(line => line.includes('file-'))).toHaveLength(5)
    expect(lines[1]).toContain('> @')
  })
})
