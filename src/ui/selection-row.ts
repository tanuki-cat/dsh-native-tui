import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** Paint a selected native row without carrying its previous text colors into the band. */
export function selectedRow(text: string, width: number, highlight: (text: string) => string): string {
  const clipped = truncateToWidth(stripTerminalSequences(text).trimEnd(), Math.max(1, width), '')
  return highlight(clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped))))
}

/** Keep native list geometry while sharing the command menu's marker and selection surface. */
export function selectionRows(lines: string[], width: number, highlight: (text: string) => string, marker = '→ '): string[] {
  return lines.map(line => {
    const plain = stripTerminalSequences(line)
    return plain.startsWith(marker) ? selectedRow('› ' + plain.slice(marker.length), width, highlight) : line
  })
}
