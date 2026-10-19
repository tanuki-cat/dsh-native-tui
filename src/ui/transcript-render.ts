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

import { Box, Container, Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import { BarText } from './bar-text.js'
import { diffLines } from './diff.js'
import { clip, compactCodeExecutionPreview, formatToolArguments } from './tool-preview.js'
import { clipGraphemes, REASONING_PREVIEW } from './reasoning-reveal.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'

/** Tools whose cards follow the code-execution density setting. */
const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['run_code', 'bash', 'pwsh'])

/**
 * Whether a tool name renders as a code-execution card, whose density follows
 * `runCodeDisplay` rather than the generic tool card.
 * @param name - tool name from the durable `tool/call`.
 * @returns true for `run_code`, `bash` and `pwsh`.
 */
export function isCodeExecutionTool(name: string): boolean {
  return CODE_EXECUTION_TOOLS.has(name)
}

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
      container.addChild(new Text(block.text, 0, 0))
      return band(container, palette.userBand)
    }
    case 'assistant': {
      const container = new Container()
      const label = palette.bold(palette.accent('◆ assistant'))
        + (block.live === true ? '  ' + palette.warning('streaming') : '')
      container.addChild(new Text(label, 0, 0))
      const mode = options.thinkingDisplay ?? 'detailed'
      if (block.starting === true) {
        if (mode === 'compact') {
          container.addChild(new Spacer(1))
          container.addChild(new Text(palette.dim('thinking · …'), 0, 0))
        }
        else if (mode !== 'hidden') {
          const reasoning = new Container()
          reasoning.addChild(new Text(palette.dim('thinking …'), 0, 0))
          container.addChild(new Spacer(1))
          container.addChild(band(reasoning, palette.thinkingBand))
        }
      }
      else if (block.reasoning !== undefined && block.reasoning.trim() !== '') {
        if (mode === 'compact') {
          const firstLine = block.reasoning.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
          container.addChild(new Spacer(1))
          container.addChild(new Text(palette.dim('thinking · ' + clipGraphemes(firstLine, 240)), 0, 0))
        }
        else if (mode !== 'hidden') {
          const reasoning = new Container()
          reasoning.addChild(new Text(palette.dim('thinking'), 0, 0))
          reasoning.addChild(new Text(palette.dim(clipGraphemes(block.reasoning, REASONING_PREVIEW)), 0, 0))
          container.addChild(new Spacer(1))
          container.addChild(band(reasoning, palette.thinkingBand))
        }
      }
      // The answer streams on its own schedule; a still-revealing reasoning
      // body above it must not hold it back, or the whole answer pops in on the
      // frame the reasoning finishes.
      if (block.text.trim() !== '') {
        container.addChild(new Spacer(1))
        container.addChild(new Markdown(block.text, 0, 0, options.markdown))
      }
      return container
    }
    case 'context': {
      const container = new Container()
      container.addChild(new Text(palette.dim('◇ context · ' + block.label), 0, 0))
      container.addChild(new BarText(clip(block.text), '│ ', palette.dim, palette.dim))
      return container
    }
    case 'tool': {
      const status = block.pending ? palette.warning('running') : block.isError === true ? palette.error('error') : palette.success('done')
      if (isCodeExecutionTool(block.name) && (options.runCodeDisplay ?? 'detailed') === 'compact') {
        const preview = compactCodeExecutionPreview(block)
        return new Text(palette.bold(palette.accent('⚙ ' + block.name)) + '  ' + status
          + (preview === '' ? '' : '  ·  ' + palette.dim(preview)), 0, 0)
      }
      const container = new Container()
      container.addChild(new Text(palette.bold(palette.accent('⚙ ' + block.name)) + '  ' + status, 0, 0))
      if (block.args.trim() !== '') {
        container.addChild(new Text(palette.dim('├ args'), 0, 0))
        container.addChild(new BarText(formatToolArguments(block.args), '│ ', palette.dim, palette.dim))
      }
      if (block.result !== undefined && block.result.trim() !== '') {
        container.addChild(new Text(palette.dim('├ result'), 0, 0))
        container.addChild(new BarText(
          clip(block.result),
          '│ ',
          block.isError === true ? palette.error : line => line,
          block.isError === true ? palette.error : palette.dim,
        ))
      }
      if (block.diffs !== undefined) {
        const lines = [palette.dim('├ diff')]
        for (const diff of block.diffs) {
          lines.push(palette.bold(palette.accent('│ diff ' + diff.path)))
          for (const row of diffLines(diff.oldText, diff.newText, 60)) {
            lines.push(row.kind === 'add'
              ? palette.success('│ + ' + row.text)
              : row.kind === 'remove' ? palette.error('│ - ' + row.text) : palette.dim('│   ' + row.text))
          }
        }
        container.addChild(new Text(lines.join('\n'), 0, 0))
      }
      return band(container, palette.toolBand)
    }
    case 'compaction': {
      const container = new Container()
      const meta = [
        block.shadowedItems === undefined ? undefined : String(block.shadowedItems) + ' item(s)',
        block.shadowedTokens === undefined ? undefined : '~' + String(block.shadowedTokens) + ' tokens',
      ].filter((value): value is string => value !== undefined)
      const title = block.state === 'error'
        ? '✕ Compaction failed'
        : block.state === 'interrupted'
          ? '⚠ Compaction interrupted'
          : block.state === 'running' ? '⟳ Compacting context…' : '✓ Context compacted'
      container.addChild(new Text(palette.bold(palette.accent(title)) + (meta.length === 0 ? '' : '  ' + palette.dim(meta.join(' · '))), 0, 0))
      if (block.summary !== undefined && block.summary.trim() !== '') {
        container.addChild(new BarText(clip(block.summary, 800), '│ ', palette.dim, palette.dim))
      }
      if (block.state === 'interrupted') {
        container.addChild(new Text(palette.warning(clip('Stopped before it committed; the session reopened after it.', 600)), 0, 0))
      }
      if (block.error !== undefined) container.addChild(new Text(palette.error(clip(block.error, 600)), 0, 0))
      return container
    }
    case 'waiting': {
      return new Text(palette.accent('⟳ ') + palette.dim(block.text), 0, 0)
    }
    case 'notice': {
      const text = block.text.replaceAll('\n', '\n  ')
      if (block.tone === 'error') return new Text(palette.error('✕ ' + text), 0, 0)
      if (block.tone === 'warning') return new Text(palette.warning('! ' + text), 0, 0)
      return new Text(palette.dim('i ') + text, 0, 0)
    }
  }
}
