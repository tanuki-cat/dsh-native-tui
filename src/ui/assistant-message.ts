import { Box, Container, Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import { clipGraphemes } from './grapheme-preview.js'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import type { AssistantPart } from './transcript-stream.js'

type AssistantBlock = Extract<TranscriptBlock, { kind: 'assistant' }>
interface PartComponent {
  readonly type: AssistantPart['type'] | 'starting'
  readonly text: string
  readonly raw: string
  readonly component: Component
  readonly body: Text | Markdown
}

/** One message keeps its completed parts and only updates the streaming leaf. */
export class AssistantMessage extends Container {
  private parts: PartComponent[] = []
  private readonly header: Text
  private readonly gap = new Spacer(1)

  constructor(block: AssistantBlock, private readonly options: TranscriptOptions) {
    super()
    this.header = new Text(options.palette.bold(options.palette.accent('◆ assistant')), 0, 0)
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
    if (block.starting && mode !== 'hidden') visible.push({ type: 'starting', raw: '', text: mode === 'compact' ? 'thinking · …' : 'thinking …' })
    for (const part of content) {
      if (part.text.trim() === '' || part.type === 'reasoning' && mode === 'hidden') continue
      const before = this.parts[visible.length]
      const text = before?.type === part.type && before.raw === part.text ? before.text
        : part.type === 'text' ? part.text : mode === 'compact'
          ? 'thinking · ' + clipGraphemes(part.text.split('\n').map(line => line.trim()).find(Boolean) ?? '', 240)
          : part.text
      visible.push({ type: part.type, text, raw: part.text })
    }
    const next = visible.map((part, index): PartComponent => {
      const before = this.parts[index]
      if (before?.type === part.type) {
        if (before.text !== part.text) before.body.setText(part.type === 'text' ? part.text : palette.dim(part.text))
        return before.text === part.text && before.raw === part.raw ? before : { ...before, ...part }
      }
      if (part.type === 'text') {
        const body = new Markdown(part.text, 0, 0, this.options.markdown)
        return { ...part, component: body, body }
      }
      const body = new Text(palette.dim(part.text), 0, 0)
      if (mode === 'compact') return { ...part, component: body, body }
      const box = new Box(1, 0, palette.thinkingBand)
      if (part.type !== 'starting') box.addChild(new Text(palette.dim('thinking'), 0, 0))
      box.addChild(body)
      return { ...part, component: box, body }
    })
    if (next.length !== this.parts.length || next.some((part, index) => part.component !== this.parts[index]?.component)) {
      this.children = [this.header]
      for (const part of next) this.children.push(this.gap, part.component)
    }
    this.parts = next
  }
}
