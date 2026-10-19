import { describe, expect, it } from 'vitest'
import { globalShortcut, type ShortcutState } from '../src/ui/keymap.js'

const state = (next: Partial<ShortcutState> = {}): ShortcutState => ({
  running: false,
  editorFocused: true,
  editorHasText: false,
  ...next,
})

describe('globalShortcut', () => {
  it('cancels a running turn with legacy and kitty Escape encodings', () => {
    expect(globalShortcut('\x1b', state({ running: true }))).toBe('cancel-turn')
    expect(globalShortcut('\x1b[27u', state({ running: true }))).toBe('cancel-turn')
    expect(globalShortcut('\x1b[27;5u', state({ running: true }))).toBeUndefined()
  })

  it('leaves Escape to the editor or a visible dialog when no turn is running', () => {
    expect(globalShortcut('\x1b', state())).toBeUndefined()
    expect(globalShortcut('\x1b[27u', state())).toBeUndefined()
    expect(globalShortcut('\x1b[27;1:3u', state({ running: true }))).toBeUndefined()
  })

  it('clears a focused editor draft before Escape reaches the running turn', () => {
    for (const running of [false, true]) {
      expect(globalShortcut('\x1b', state({ running, editorHasText: true }))).toBe('clear-input')
      expect(globalShortcut('\x1b[27u', state({ running, editorHasText: true }))).toBe('clear-input')
    }
  })

  it('does not clear an unfocused or empty editor', () => {
    expect(globalShortcut('\x1b', state({ editorFocused: false, editorHasText: true }))).toBeUndefined()
    expect(globalShortcut('\x1b', state({ running: true, editorFocused: false, editorHasText: true }))).toBe('cancel-turn')
    expect(globalShortcut('\x1b', state({ running: true, editorHasText: false }))).toBe('cancel-turn')
    expect(globalShortcut('\x1b[27;1:3u', state({ editorHasText: true }))).toBeUndefined()
  })

  it('maps Ctrl+C to cancel while running and exit while idle', () => {
    for (const data of ['\x03', '\x1b[99;5u']) {
      expect(globalShortcut(data, state({ running: true }))).toBe('cancel-turn')
      expect(globalShortcut(data, state())).toBe('exit')
    }
  })

  it('maps Ctrl+D to exit and ignores other input', () => {
    for (const data of ['\x04', '\x1b[100;5u']) expect(globalShortcut(data, state({ running: true }))).toBe('exit')
    expect(globalShortcut('a', state({ running: true }))).toBeUndefined()
    expect(globalShortcut('\x1b[A', state({ editorHasText: true }))).toBeUndefined()
  })
})
