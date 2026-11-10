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
import { ToolCard } from './tool-card.js'
import { clip } from './tool-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import { MessageBody } from './transcript-chrome.js'
import { ContextMessage } from './context-message.js'
import { activityHeading, styleTurnStatus, WaitStatusLine } from './waiting.js'

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
    const box = new Box(0, 1, background)
    box.addChild(component)
    return box
  }
  switch (block.kind) {
    case 'user': {
      return band(new MessageBody(new Text(sanitizeTerminalText(block.text), 0, 0), palette, '› '), palette.userBand)
    }
    case 'assistant': return new AssistantMessage(block, options)
    case 'context': return new ContextMessage(block, palette, options.toolsExpanded ?? false)
    case 'tool': return new ToolCard(block, options)
    case 'compaction': {
      // The head line stays fixed like the tool card head: the compaction
      // state lands on the tail row, which main-screen can patch safely while
      // the card is still inside the viewport or after it scrolled away.
      const container = new Container()
      container.addChild(new Text(activityHeading('Compact context', palette), 0, 0))
      const detail = (text: string): void => {
        container.addChild(new MessageBody(new Text(text, 0, 0), palette, '  '))
      }
      const meta = [
        block.shadowedItems === undefined ? undefined : String(block.shadowedItems) + ' item(s)',
        block.shadowedTokens === undefined ? undefined : '~' + String(block.shadowedTokens) + ' tokens',
      ].filter((value): value is string => value !== undefined)
      if (meta.length > 0) detail(palette.dim(meta.join(' · ')))
      if (block.summary !== undefined && block.summary.trim() !== '') {
        // Keep the card shorter than a typical viewport: main-screen can only
        // patch visible rows, so a card that grows past the viewport after its
        // head scrolled away forces a full repaint of the transcript.
        detail(palette.dim(clip(sanitizeTerminalText(block.summary), 240)))
      }
      if (block.state === 'interrupted') {
        detail(palette.dim('Stopped before it committed; the session reopened after it.'))
      }
      if (block.error !== undefined) detail(palette.error(clip(sanitizeTerminalText(block.error), 600)))
      // State is the last row: a compaction that finishes after its card scrolled
      // away still only touches the card's tail, never a row above the viewport.
      const state = block.state === 'error'
        ? 'Failed to compact context'
        : block.state === 'interrupted'
          ? 'Interrupted while compacting context'
          : block.state === 'running' ? 'Compacting…' : 'Context compacted'
      detail(styleTurnStatus(state, palette))
      return container
    }
    case 'waiting': {
      const line = new WaitStatusLine(palette)
      line.setText(block.text)
      return line
    }
    case 'notice': {
      const text = sanitizeTerminalText(block.text).replaceAll('\n', '\n  ')
      if (block.tone === 'error') return new Text(palette.error('✕ ' + text), 0, 0)
      if (block.tone === 'warning') return new Text(palette.warning('! ' + text), 0, 0)
      if (block.tone === 'success') return new Text(palette.success('✓ ' + text), 0, 0)
      return new Text(palette.dim('i ') + text, 0, 0)
    }
  }
}
