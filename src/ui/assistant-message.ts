import { Container, Spacer, type Component } from '@earendil-works/pi-tui'
import { clipGraphemes } from './grapheme-preview.js'
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
  readonly component: Component
  readonly body: PartBody
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
    const visible: Array<Pick<PartComponent, 'type' | 'text' | 'raw'>> = []
    for (const part of content) {
      // A signature-only block has nothing to show; it must not add a card.
      const display = part.type === 'reasoning' ? reasoningText(part.text) : part.text
      if (display.trim() === '' || part.type === 'reasoning' && mode === 'hidden') continue
      const before = this.parts[visible.length]
      const text = before?.type === part.type && before.raw === part.text ? before.text
        : part.type === 'text'
          ? sanitizeTerminalText(display)
          : mode === 'compact'
            ? 'thinking · ' + clipGraphemes(sanitizeTerminalText(reasoningPreview(display, block.live)), 240)
            : sanitizeTerminalText(display)
      visible.push({ type: part.type, text, raw: part.text })
    }
    const next = visible.map((part, index): PartComponent => {
      const before = this.parts[index]
      if (before?.type === part.type) {
        if (before.text !== part.text) before.body.setText(part.text)
        return before.text === part.text && before.raw === part.raw ? before : { ...before, ...part }
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
