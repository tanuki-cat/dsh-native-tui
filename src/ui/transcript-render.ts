/**
 * pi-tui rendering of one reduced transcript block.
 *
 * The reducer in `transcript.ts` decides which rows exist and in which order;
 * this module turns one of those rows into components. Keeping it separate
 * leaves the reducer readable and lets a row's markup change without touching
 * the event folding rules.
 *
 * @module dsh-native-tui/ui/transcript-render
 */

import { Box, Container, Text, type Component } from '@earendil-works/pi-tui'
import { AssistantMessage } from './assistant-message.js'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import { BarText } from './bar-text.js'
import { ToolCard } from './tool-card.js'
import { clip } from './tool-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'

export { isCodeExecutionTool } from './code-execution-card.js'

/**
 * Build the component tree for one reduced block.
 * @param block - one reduced transcript row.
 * @param options - palette, Markdown theme and display densities.
 * @returns the component that renders that row.
 */
export function renderTranscriptBlock(block: TranscriptBlock, options: TranscriptOptions): Component {
  const palette = options.palette
  const band = (component: Component, background: (text: string) => string): Component => {
    const box = new Box(1, 0, background)
    box.addChild(component)
    return box
  }
  switch (block.kind) {
    case 'user': {
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('▌ You')), 0, 0))
      container.addChild(new Text(sanitizeTerminalText(block.text), 0, 0))
      return band(container, palette.userBand)
    }
    case 'assistant': return new AssistantMessage(block, options)
    case 'context': {
      const container = new Container()
      container.addChild(new Text(palette.dim('◇ context · ' + sanitizeTerminalText(block.label)), 0, 0))
      container.addChild(new BarText(clip(sanitizeTerminalText(block.text)), '│ ', palette.dim, palette.dim))
      return container
    }
    case 'tool': return new ToolCard(block, options)
    case 'compaction': {
      // The head line stays fixed like the tool card head: the compaction
      // state lands on the tail row, which main-screen can patch safely while
      // the card is still inside the viewport or after it scrolled away.
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('◆ compaction')), 0, 0))
      const meta = [
        block.shadowedItems === undefined ? undefined : String(block.shadowedItems) + ' item(s)',
        block.shadowedTokens === undefined ? undefined : '~' + String(block.shadowedTokens) + ' tokens',
      ].filter((value): value is string => value !== undefined)
      if (meta.length > 0) container.addChild(new Text(palette.dim(meta.join(' · ')), 0, 0))
      if (block.summary !== undefined && block.summary.trim() !== '') {
        // Keep the card shorter than a typical viewport: main-screen can only
        // patch visible rows, so a card that grows past the viewport after its
        // head scrolled away forces a full repaint of the transcript.
        container.addChild(new BarText(clip(sanitizeTerminalText(block.summary), 240), '│ ', palette.dim, palette.dim))
      }
      if (block.state === 'interrupted') {
        container.addChild(new Text(palette.warning(clip('Stopped before it committed; the session reopened after it.', 600)), 0, 0))
      }
      if (block.error !== undefined) container.addChild(new Text(palette.error(clip(sanitizeTerminalText(block.error), 600)), 0, 0))
      // State is the last row: a compaction that finishes after its card scrolled
      // away still only touches the card's tail, never a row above the viewport.
      const state = block.state === 'error'
        ? palette.error('✕ failed')
        : block.state === 'interrupted'
          ? palette.warning('⚠ interrupted')
          : block.state === 'running' ? palette.accent('⟳ compacting…') : palette.success('✓ done')
      container.addChild(new Text(state, 0, 0))
      return container
    }
    case 'waiting': {
      return new Text(palette.accent('⟳ ') + palette.dim(sanitizeTerminalText(block.text)), 0, 0)
    }
    case 'notice': {
      const text = sanitizeTerminalText(block.text).replaceAll('\n', '\n  ')
      if (block.tone === 'error') return new Text(palette.error('✕ ' + text), 0, 0)
      if (block.tone === 'warning') return new Text(palette.warning('! ' + text), 0, 0)
      return new Text(palette.dim('i ') + text, 0, 0)
    }
  }
}
