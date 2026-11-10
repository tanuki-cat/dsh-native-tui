import { Text, type Component } from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import type { ToolFileDiff } from '../runtime/tool-log.js'
import { renderEditDiff } from './edit-card.js'
import type { Palette } from './theme.js'

/** The diff inspector shares inline line numbers, safe source text and changed-row surfaces. */
export class DiffPreview implements Component {
  constructor(private readonly diffs: readonly ToolFileDiff[], private readonly palette: Palette) {}

  render(width: number): string[] {
    return this.diffs.flatMap(diff => [
      ...new Text(this.palette.bold(sanitizeTerminalText(diff.path)), 0, 0).render(width),
      ...renderEditDiff(diff, this.palette, true).render(width),
    ])
  }

  invalidate(): void {}
}
