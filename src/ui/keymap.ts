import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui'

/** One global terminal shortcut handled before the focused component. */
export type GlobalShortcut = 'cancel-turn' | 'exit'

/**
 * Map raw terminal input to a global shortcut. Kitty and xterm modified-key
 * modes encode these keys as CSI sequences, so matching must go through
 * pi-tui instead of comparing the legacy control bytes.
 * @param data - raw input sequence received from the terminal.
 * @param running - whether the active agent is currently running.
 * @returns the shortcut, or undefined when the input belongs to the editor or a dialog.
 */
export function globalShortcut(data: string, running: boolean): GlobalShortcut | undefined {
  if (isKeyRelease(data)) return undefined
  if (matchesKey(data, 'escape')) return running ? 'cancel-turn' : undefined
  if (matchesKey(data, 'ctrl+c')) return running ? 'cancel-turn' : 'exit'
  if (matchesKey(data, 'ctrl+d')) return 'exit'
  return undefined
}
