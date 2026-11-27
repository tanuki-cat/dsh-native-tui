import { Container, Spacer, type Component } from '@earendil-works/pi-tui'
import { clipTextToWidth } from './grapheme-preview.js'
import { reasoningPreview, reasoningText } from './reasoning-text.js'
import { sanitizeTerminalText } from '../runtime/terminal-text.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import type { AssistantPart } from './transcript-stream.js'
import { StreamMarkdown } from './stream-markdown.js'
import { StreamText } from './stream-text.js'
import { MessageBody } from './transcript-chrome.js'

type AssistantBlock = Extract<TranscriptBlock, { kind: 'assistant' }>

/** Body a part grows into; both re-render only the tail an append touched. */
type PartBody = StreamText | StreamMarkdown

interface PartComponent {
  readonly type: AssistantPart['type']
  readonly text: string
  readonly raw: string
  readonly display: string
  /** Whether `display` contains any ESC/C1 byte that could open a multi-chunk sequence. */
  readonly hasControl: boolean
  /** Whether this part belongs to a still-streaming block; compact previews follow it. */
  readonly live: boolean
  readonly component: Component
  readonly body: PartBody
}

const CONTROL_BYTE = /[\u001B\u0080-\u009F]/u

/** Display columns one compact thinking preview may occupy. */
const COMPACT_THINKING_COLUMNS = 240

/**
 * Whether appending a chunk can reuse the already sanitized prefix.
 *
 * Sanitizing a slice cannot see a terminal sequence whose introducer is in the
 * settled prefix, so the prefix must be plain text. Tracking `hasControl`
 * incrementally per appended chunk keeps normal streaming O(n) while still
 * catching arbitrarily long OSC 8 bodies or URIs.
 */
function canIncrementallySanitize(previous: PartComponent, next: string): boolean {
  return !previous.hasControl && !previous.display.endsWith('\r') && next.startsWith(previous.display)
}

/** One message keeps its completed parts and only updates the streaming leaf. */
export class AssistantMessage extends Container {
  private parts: PartComponent[] = []
  private readonly gap = new Spacer(1)

  constructor(block: AssistantBlock, private readonly options: TranscriptOptions) {
    super()
    this.update(block)
  }

  update(block: AssistantBlock): void {
    const { palette } = this.options
    const mode = this.options.thinkingDisplay ?? (this.options.showReasoning ? 'detailed' : 'hidden')
    const content = block.content ?? [
      ...(block.reasoning === undefined ? [] : [{ type: 'reasoning' as const, text: block.reasoning }]),
      { type: 'text' as const, text: block.text },
    ]
    const visible: Array<Pick<PartComponent, 'type' | 'text' | 'raw' | 'display' | 'hasControl' | 'live'>> = []
    for (const part of content) {
      // A signature-only block has nothing to show; it must not add a card.
      const display = part.type === 'reasoning' ? reasoningText(part.text) : part.text
      if (display.trim() === '' || part.type === 'reasoning' && mode === 'hidden') continue
      const live = part.type === 'reasoning' && block.live
      const before = this.parts[visible.length]
      const extendsPrefix = before?.type === part.type && display.startsWith(before.display)
      const delta = extendsPrefix ? display.slice(before.display.length) : display
      const hasControl = extendsPrefix ? before.hasControl || CONTROL_BYTE.test(delta) : CONTROL_BYTE.test(display)
      let text: string
      if (before?.type === part.type && before.raw === part.text && before.live === live) {
        text = before.text
      } else if (part.type === 'text' || mode !== 'compact') {
        text = before?.type === part.type && before.live === live && canIncrementallySanitize(before, display)
          ? before.text + sanitizeTerminalText(delta)
          : sanitizeTerminalText(display)
      } else {
        // The compact row is one line: bound it by display columns, not by a
        // grapheme count that lets wide CJK clusters span several rows.
        text = 'thinking · ' + clipTextToWidth(sanitizeTerminalText(reasoningPreview(display, block.live)), COMPACT_THINKING_COLUMNS)
      }
      visible.push({ type: part.type, text, raw: part.text, display, hasControl, live })
    }
    const next = visible.map((part, index): PartComponent => {
      const before = this.parts[index]
      if (before?.type === part.type) {
        if (before.text !== part.text) before.body.setText(part.text)
        return before.text === part.text && before.raw === part.raw && before.live === part.live
          ? before
          : { ...before, ...part }
      }
      if (part.type === 'text') {
        const body = new StreamMarkdown(part.text, this.options.markdown)
        return { ...part, component: new MessageBody(body, palette, '• '), body }
      }
      // Reasoning is styled per rendered line, so no ANSI state has to cross a
      // line boundary when the tail is re-wrapped on its own.
      const body = new StreamText(part.text, line => palette.dim(palette.italic(line)))
      return { ...part, component: new MessageBody(body, palette, '  '), body }
    })
    if (next.length !== this.parts.length || next.some((part, index) => part.component !== this.parts[index]?.component)) {
      this.children = []
      for (const [index, part] of next.entries()) {
        if (index > 0) this.children.push(this.gap)
        this.children.push(part.component)
      }
    }
    this.parts = next
  }
}
