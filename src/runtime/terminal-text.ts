import { stripTerminalSequences } from '@earendil-works/pi-tui'

/** Remove untrusted terminal instructions before adding UI-owned styling. */
export function sanitizeTerminalText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
}
