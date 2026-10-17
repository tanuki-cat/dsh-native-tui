import { describe, expect, it } from 'vitest'
import { globalShortcut } from '../src/ui/keymap.js'

describe('globalShortcut', () => {
  it('cancels a running turn with legacy and kitty Escape encodings', () => {
    expect(globalShortcut('\x1b', true)).toBe('cancel-turn')
    expect(globalShortcut('\x1b[27u', true)).toBe('cancel-turn')
    expect(globalShortcut('\x1b[27;5u', true)).toBeUndefined()
  })

  it('leaves Escape to the editor or a visible dialog when no turn is running', () => {
    expect(globalShortcut('\x1b', false)).toBeUndefined()
    expect(globalShortcut('\x1b[27u', false)).toBeUndefined()
    expect(globalShortcut('\x1b[27;1:3u', true)).toBeUndefined()
  })

  it('maps Ctrl+C to cancel while running and exit while idle', () => {
    for (const data of ['\x03', '\x1b[99;5u']) {
      expect(globalShortcut(data, true)).toBe('cancel-turn')
      expect(globalShortcut(data, false)).toBe('exit')
    }
  })

  it('maps Ctrl+D to exit and ignores other input', () => {
    for (const data of ['\x04', '\x1b[100;5u']) expect(globalShortcut(data, true)).toBe('exit')
    expect(globalShortcut('a', true)).toBeUndefined()
    expect(globalShortcut('\x1b[A', true)).toBeUndefined()
  })
})
