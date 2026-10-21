import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import { reasoningRevealFrom, rememberRevealProgress, revealCompletedReasoning, revealStreamText, type RevealProgress } from './reasoning-reveal.js'

export interface AssistantPart {
  readonly type: 'text' | 'reasoning'
  readonly text: string
}

interface StreamPart extends AssistantPart {
  readonly index: number
  readonly progressKey: string
  readonly from?: number
  readonly deltas?: boolean
  readonly open?: boolean
}

/** Accumulates one attempt in provider order; projection never mutates the received content. */
export class AssistantStream {
  private parts: StreamPart[] = []
  private live = true
  private seq: number | undefined
  private starting = false
  private animated = false
  private dirty = true
  private projected: TranscriptBlock | undefined
  private readonly progress = new Map<string, RevealProgress>()
  /** Time new stream content was actually projected, not when the model produced it. */
  visibleAt: number | undefined

  constructor(readonly key: string, private readonly options: TranscriptOptions) {}

  private progressKey(type: AssistantPart['type'], index: number): string {
    const prefix = type === 'text' ? 'text:' : 'reasoning:'
    const first = this.parts.find(part => part.type === type)
    return prefix + this.key + (first === undefined || first.index === index ? '' : ':part:' + String(index))
  }

  append(chunk: StreamChunk, time: number): void {
    this.dirty = true
    if (chunk.type === 'block-start') {
      if (chunk.blockType !== 'reasoning' && chunk.blockType !== 'text') return
      if (chunk.blockType === 'reasoning') this.starting = true
      if (!this.parts.some(part => part.index === chunk.index)) {
        this.parts.push({ type: chunk.blockType, index: chunk.index, text: '', open: true, progressKey: this.progressKey(chunk.blockType, chunk.index) })
        this.parts.sort((left, right) => left.index - right.index)
      }
      return
    }
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'block-end') return
    const type = chunk.type === 'block-end' ? chunk.block.type : chunk.type === 'text-delta' ? 'text' : 'reasoning'
    if (type !== 'text' && type !== 'reasoning') return
    const text = chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
      ? chunk.block.text : 'text' in chunk ? chunk.text : ''
    const index = chunk.index ?? this.parts.at(-1)?.index ?? 0
    const position = this.parts.findIndex(part => part.index === index && part.type === type)
    const previous = this.parts[position]
    const deltas = chunk.type !== 'block-end' || previous?.deltas === true
    const progressKey = previous?.progressKey ?? this.progressKey(type, index)
    const part: StreamPart = {
      type, index, progressKey, deltas,
      open: chunk.type === 'block-end' ? false : previous?.open,
      text: chunk.type === 'block-end'
        ? text.length >= (previous?.text.length ?? 0) ? text : previous!.text
        : (previous?.text ?? '') + text,
      ...(chunk.type === 'block-end' ? { from: time } : {}),
    }
    if (position < 0) {
      this.parts.push(part)
      this.parts.sort((left, right) => left.index - right.index)
    }
    else this.parts[position] = part
    this.starting = false
    this.animated = true
    const progress = this.options.revealProgress
    if (progress !== undefined && !progress.has(progressKey)) {
      rememberRevealProgress(progress, progressKey, { start: time, visible: 0 })
    }
  }

  settle(content: readonly ContentBlock[], stream: readonly AssistantStreamRecord[] | undefined, seq: number): void {
    this.live = false
    this.dirty = true
    this.seq = seq
    this.starting = false
    const from = reasoningRevealFrom(stream)
    const old = this.parts
    const progress = this.options.revealProgress
    this.animated ||= ['text:', 'reasoning:'].some(prefix => progress?.has(prefix + this.key))
    this.parts = content.flatMap((block, index): StreamPart[] => {
      if (block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal') return []
      const type = block.type === 'reasoning' ? 'reasoning' : 'text'
      const text = block.type === 'text' || block.type === 'reasoning' ? block.text
        : block.type === 'image' ? '[image ' + (block.attachment.name ?? block.attachment.mediaType) + ']'
          : block.type === 'file' ? '[file ' + block.attachment.name + ']' : '[content]'
      const previous = old.find(part => part.index === index && part.type === type)
      const deltas = previous?.deltas ?? (type === 'reasoning' && from === undefined)
      // The subscription may replace all live entries before the next frame.
      const prefix = type === 'text' ? 'text:' : 'reasoning:'
      const progressKey = previous?.progressKey ?? prefix + this.key
        + (content.slice(0, index).some(part => part.type === block.type) ? ':part:' + String(index) : '')
      return [{ type, text, index, progressKey, deltas, ...(from === undefined ? {} : { from }) }]
    })
  }

  project(now: number): TranscriptBlock {
    if (!this.dirty && this.projected?.kind === 'assistant' && this.projected.revealing !== true) return this.projected
    this.dirty = false
    const content: AssistantPart[] = []
    const mode = this.options.thinkingDisplay ?? (this.options.showReasoning ? 'detailed' : 'hidden')
    let pending = false
    let hold = false
    let advanced = false
    for (const part of this.parts) {
      if (part.type === 'reasoning' && mode === 'hidden') continue
      if (hold) {
        pending = true
        break
      }
      let text = part.text
      let revealing = false
      const progress = this.options.revealProgress
      if (progress !== undefined && this.animated) {
        let state = this.progress.get(part.progressKey) ?? progress.get(part.progressKey)
        if (state === undefined) {
          state = { start: now, visible: 0 }
          rememberRevealProgress(progress, part.progressKey, state)
        }
        this.progress.set(part.progressKey, state)
        const visible = state.visible
        if (part.type === 'reasoning' && mode === 'compact') state.visible = text.length
        else {
          if (state.visible < text.length) {
            if (advanced) {
              pending = true
              break
            }
            advanced = true
          }
          const result = revealStreamText(text, state, now)
          text = result.text
          revealing = result.pending
        }
        if (text.length > 0) {
          if (state.paintedAt === undefined || visible !== text.length) state.paintedAt = now
          this.visibleAt = Math.max(this.visibleAt ?? state.paintedAt, state.paintedAt)
        }
      }
      else if (progress === undefined && part.type === 'reasoning' && !part.deltas && part.from !== undefined && mode === 'detailed') {
        const result = revealCompletedReasoning(text, now, part.from)
        text = result.text
        revealing = result.pending
      }
      if (text !== '') content.push({ type: part.type, text })
      if (revealing || part.open && this.parts.at(-1) !== part) {
        pending = true
        hold = true
      }
    }
    const block: TranscriptBlock = {
      kind: 'assistant',
      text: content.filter(part => part.type === 'text').map(part => part.text).join(''),
      ...(content.some(part => part.type === 'reasoning') ? { reasoning: content.filter(part => part.type === 'reasoning').map(part => part.text).join('') } : {}),
      content,
      live: this.live,
      ...(this.live ? { streamKey: this.key } : {}),
      ...(this.seq === undefined ? {} : { seq: this.seq }),
      ...(content.length === 0 && (this.starting || pending && this.parts[0]?.type === 'reasoning') ? { starting: true } : {}),
      ...(pending ? { revealing: true } : {}),
    }
    const previous = this.projected
    if (previous?.kind === 'assistant' && previous.text === block.text && previous.reasoning === block.reasoning
      && previous.live === block.live && previous.seq === block.seq && previous.starting === block.starting
      && previous.revealing === block.revealing && previous.content?.length === content.length
      && previous.content.every((part, index) => part.type === content[index]!.type && part.text === content[index]!.text)) return previous
    this.projected = block
    return block
  }
}
