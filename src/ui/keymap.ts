import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui'

/** One global terminal shortcut handled before the focused component. */
export type GlobalShortcut = 'cancel-turn' | 'clear-input' | 'exit' | 'toggle-write-preview'

/** Terminal state that decides what a global shortcut means. */
export interface ShortcutState {
  /** Whether the active agent is currently running. */
  running: boolean
  /** Whether the prompt editor owns keyboard focus. */
  editorFocused: boolean
  /** Whether the prompt editor holds any text. */
  editorHasText: boolean
}

/**
 * Map raw terminal input to a global shortcut. Kitty and xterm modified-key
 * modes encode these keys as CSI sequences, so matching must go through
 * pi-tui instead of comparing the legacy control bytes.
 * @param data - raw input sequence received from the terminal.
 * @param state - terminal state that decides what a shortcut means.
 * @returns the shortcut, or undefined when the input belongs to the editor or a dialog.
 */
export function globalShortcut(data: string, state: ShortcutState): GlobalShortcut | undefined {
  if (isKeyRelease(data)) return undefined
  if (matchesKey(data, 'escape')) {
    // A draft belongs to the user: Escape discards it before it can reach the
    // turn, so a running turn only sees Escape when the editor is empty.
    if (state.editorFocused && state.editorHasText) return 'clear-input'
    return state.running ? 'cancel-turn' : undefined
  }
  if (state.editorFocused && matchesKey(data, 'ctrl+o')) return 'toggle-write-preview'
  if (matchesKey(data, 'ctrl+c')) return state.running ? 'cancel-turn' : 'exit'
  if (matchesKey(data, 'ctrl+d')) return 'exit'
  return undefined
}
