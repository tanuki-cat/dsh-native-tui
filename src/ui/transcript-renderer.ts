/**
 * The pi-tui component tree for one reduced transcript.
 *
 * The reducer in `transcript.ts` folds events into block data and the block
 * markup lives in `transcript-render.ts`. This module owns the part in
 * between: it keeps a block's component alive across rebuilds and places local
 * notices at their durable sequence.
 *
 * @module dsh-native-tui/ui/transcript-renderer
 */

import { Container, Spacer, type Component } from '@earendil-works/pi-tui'
import { Rule } from './rule.js'
import type { DisplayMode } from '../config.js'
import { reduceTranscriptWindow, type TranscriptBlock, type TranscriptEntry, type TranscriptOptions } from './transcript.js'
import { renderTranscriptBlock } from './transcript-render.js'

/**
 * Whether a rebuilt block renders exactly what its predecessor rendered.
 * Blocks are pure data, so a field-wise comparison decides it without
 * touching the component tree. Arrays compare by length and element identity,
 * which fails safe: a false negative only rebuilds one component.
 * @param left - block from the previous rebuild.
 * @param right - block from the current rebuild.
 * @returns true when the previous component can be reused.
 */
export function sameTranscriptBlock(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  const previous = right as unknown as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(previous).length) return false
  for (const key of keys) {
    const before = (left as unknown as Record<string, unknown>)[key]
    const after = previous[key]
    if (before === after) continue
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) return false
      for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) return false
      continue
    }
    return false
  }
  return true
}

/**
 * Stable identity of one reduced block, for carrying its component across a
 * rebuild. `maxEntries` drops old rows from the front and shifts every later
 * block's index, so index alignment cannot decide reuse. A live assistant
 * block has no durable identity and is rebuilt every frame by design.
 * @param block - one reduced block.
 * @returns a key stable for the block's lifetime, or undefined when it has none.
 */
function blockKey(block: TranscriptBlock): string | undefined {
  switch (block.kind) {
    case 'tool': return 'tool:' + block.callId
    case 'compaction': return 'compaction:' + block.compactionId
    case 'assistant': return block.live || block.seq === undefined ? undefined : 'assistant:' + String(block.seq)
    case 'user': return block.seq === undefined ? undefined : 'user:' + String(block.seq)
    case 'context': return block.seq === undefined ? undefined : 'context:' + String(block.seq)
    case 'notice': return block.seq === undefined ? undefined : 'notice:' + String(block.seq)
    case 'waiting': return undefined
  }
}

/** Pi-tui renderer for one reduced transcript. */
export class TranscriptRenderer {
  readonly container = new Container()
  private entries: readonly TranscriptEntry[] = []
  private extra: readonly TranscriptBlock[] = []
  /** Component per stable block identity from the previous rebuild. */
  private cached = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
  private retained = 0
  private liveChars = 0
  private revealPending = false
  private options: TranscriptOptions

  /**
   * Index into the last reduced event window below which no retained block
   * needs anything. A caller may drop that prefix before the next rebuild.
   */
  get retainedFrom(): number {
    return this.retained
  }

  /** Characters in the trailing live assistant block; its re-render dominates a stream frame. */
  get liveContentLength(): number {
    return this.liveChars
  }

  /** True while a completed reasoning block is still being revealed across frames. */
  get liveRevealPending(): boolean {
    return this.revealPending
  }

  /**
   * @param options - reduction and styling options.
   */
  constructor(options: TranscriptOptions) {
    this.options = {
      ...options,
      revealProgress: options.revealProgress ?? new Map(),
      toolMemory: options.toolMemory ?? {
        settled: new Set(),
        pruned: new Set(),
        prunedSeqs: new Set(),
        callBySeq: new Map(),
      },
    }
  }

  /** Switch reasoning/code-execution density and rebuild the existing event window. */
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void {
    if (this.options.thinkingDisplay === thinkingDisplay && this.options.runCodeDisplay === runCodeDisplay) return
    this.options = { ...this.options, thinkingDisplay, runCodeDisplay }
    // Density is a render option rather than part of TranscriptBlock, so a block
    // can stay equal while its component must switch representation. Drop the
    // reuse window; otherwise the previous density keeps rendering.
    this.cached.clear()
    this.rebuild()
  }

  /** Change the retained transcript row budget and rebuild. */
  setMaxEntries(maxEntries: number): void {
    this.options = { ...this.options, maxEntries }
    this.rebuild()
  }

  /** Replace both the event window and local notices in one rebuild. */
  set(entries: readonly TranscriptEntry[], notices: readonly TranscriptBlock[]): void {
    this.entries = entries
    this.extra = notices
    this.rebuild()
  }

  /** Replace the event window and rebuilt rows. */
  setEntries(entries: readonly TranscriptEntry[]): void {
    this.entries = entries
    this.rebuild()
  }

  /** Add local-only notices after the durable transcript. */
  setNotices(notices: readonly TranscriptBlock[]): void {
    this.extra = notices
    this.rebuild()
  }

  /** Remove every rendered row, including local notices. */
  clear(): void {
    this.entries = []
    this.extra = []
    this.revealPending = false
    this.options.revealProgress?.clear()
    this.options.toolMemory?.settled.clear()
    this.options.toolMemory?.pruned.clear()
    this.options.toolMemory?.prunedSeqs.clear()
    this.options.toolMemory?.callBySeq.clear()
    this.cached.clear()
    this.container.clear()
  }

  private rebuild(): void {
    const reduction = reduceTranscriptWindow(this.entries, this.options)
    this.retained = reduction.retainedFrom
    this.revealPending = reduction.revealPending
    const durable = reduction.blocks
    const anchored = this.extra.filter((notice): notice is TranscriptBlock & { afterSeq: number } => notice.afterSeq !== undefined)
    const trailing = this.extra.filter(notice => notice.afterSeq === undefined)
    const blocks: TranscriptBlock[] = []
    const pending = [...anchored]
    for (const block of durable) {
      while (pending.length > 0 && pending[0]!.afterSeq < (block.seq ?? Number.POSITIVE_INFINITY)) {
        blocks.push(pending.shift()!)
      }
      blocks.push(block)
    }
    blocks.push(...pending, ...trailing)
    const next = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
    let liveChars = 0
    this.container.clear()
    for (const [index, block] of blocks.entries()) {
      if (block.kind === 'assistant' && block.live) liveChars += block.text.length + (block.reasoning?.length ?? 0)
      if (index > 0) this.container.addChild(new Spacer(1))
      if (index > 0 && block.kind === 'user') {
        this.container.addChild(new Rule(this.options.palette.dim))
        this.container.addChild(new Spacer(1))
      }
      const key = blockKey(block)
      const previous = key === undefined ? undefined : this.cached.get(key)
      // Streaming rewrites only the trailing live block. Reusing the rest by
      // identity keeps their parsed Markdown cached even when the window is full
      // and every block index just shifted by one.
      const component = previous !== undefined && sameTranscriptBlock(previous.block, block)
        ? previous.component
        : renderTranscriptBlock(block, this.options)
      if (key !== undefined) next.set(key, { block, component })
      this.container.addChild(component)
    }
    this.cached = next
    this.liveChars = liveChars
  }
}
