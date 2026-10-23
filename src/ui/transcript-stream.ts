import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'

export interface AssistantPart {
  readonly type: 'text' | 'reasoning'
  readonly text: string
}

interface StreamPart extends AssistantPart {
  readonly index: number
}

/** Accumulates received content in provider order without a local playback queue. */
export class AssistantStream {
  private parts: StreamPart[] = []
  private live = true
  private seq: number | undefined
  private dirty = true
  private projected: TranscriptBlock | undefined

  constructor(
    readonly key: string,
    private readonly options: TranscriptOptions,
    /** Row identity kept when an attempt replaces this stream. */
    private readonly rowKey: string = key,
  ) {}

  append(chunk: StreamChunk): void {
    if (chunk.type === 'block-start') {
      if (chunk.blockType !== 'reasoning' && chunk.blockType !== 'text') return
      this.dirty = true
      if (!this.parts.some(part => part.index === chunk.index)) {
        this.parts.push({ type: chunk.blockType, index: chunk.index, text: '' })
        this.parts.sort((left, right) => left.index - right.index)
      }
      return
    }
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'block-end') return
    const type = chunk.type === 'block-end' ? chunk.block.type : chunk.type === 'text-delta' ? 'text' : 'reasoning'
    if (type !== 'text' && type !== 'reasoning') return
    this.dirty = true
    const text = chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
      ? chunk.block.text : 'text' in chunk ? chunk.text : ''
    const index = chunk.index ?? this.parts.at(-1)?.index ?? 0
    const position = this.parts.findIndex(part => part.index === index && part.type === type)
    const previous = this.parts[position]
    const part: StreamPart = {
      type, index,
      text: chunk.type === 'block-end'
        ? text.length >= (previous?.text.length ?? 0) ? text : previous!.text
        : (previous?.text ?? '') + text,
    }
    if (position < 0) {
      this.parts.push(part)
      this.parts.sort((left, right) => left.index - right.index)
    }
    else this.parts[position] = part
  }

  settle(content: readonly ContentBlock[], seq: number): void {
    this.live = false
    this.dirty = true
    this.seq = seq
    this.parts = content.flatMap((block, index): StreamPart[] => {
      if (block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal') return []
      const type = block.type === 'reasoning' ? 'reasoning' : 'text'
      const text = block.type === 'text' || block.type === 'reasoning' ? block.text
        : block.type === 'image' ? '[image ' + (block.attachment.name ?? block.attachment.mediaType) + ']'
          : block.type === 'file' ? '[file ' + block.attachment.name + ']' : '[content]'
      return [{ type, text, index }]
    })
  }

  project(): TranscriptBlock {
    if (!this.dirty && this.projected !== undefined) return this.projected
    this.dirty = false
    const mode = this.options.thinkingDisplay ?? (this.options.showReasoning ? 'detailed' : 'hidden')
    const content: AssistantPart[] = this.parts
      .filter(part => part.text !== '' && (part.type !== 'reasoning' || mode !== 'hidden'))
      .map(({ type, text }) => ({ type, text }))
    const block: TranscriptBlock = {
      kind: 'assistant',
      text: content.filter(part => part.type === 'text').map(part => part.text).join(''),
      ...(content.some(part => part.type === 'reasoning') ? { reasoning: content.filter(part => part.type === 'reasoning').map(part => part.text).join('') } : {}),
      content,
      live: this.live,
      // Kept after settlement so a notice raised mid-stream can stay under this
      // row instead of jumping above it once the durable message assigns a seq.
      streamKey: this.rowKey,
      ...(this.seq === undefined ? {} : { seq: this.seq }),
    }
    this.projected = block
    return block
  }
}
