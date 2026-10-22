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
import { createTranscriptReducer, type TranscriptBlock, type TranscriptEntry, type TranscriptOptions } from './transcript.js'
import { AssistantMessage } from './assistant-message.js'
import { renderTranscriptBlock } from './transcript-render.js'

/**
 * One transcript row component, memoized on the width it last painted at.
 *
 * pi-tui caches inside each leaf (parsed Markdown, padded Text) but always walks
 * the whole subtree: a Box re-renders its children before its own cache can
 * match. That walk is what makes a long transcript cost O(retained rows) per
 * paint — measured at 45 ms for 2000 rows — and it runs on the same event loop
 * that reads the model stream, so it also stretched the timestamps the decode
 * rate is measured from.
 *
 * The component itself is the memo key: {@link TranscriptRenderer.rebuild}
 * reuses the component exactly when its block value did not change, so a kept
 * component may keep its lines until the width moves. A rebuilt row gets a new
 * component and therefore a cold cache.
 */
class MemoBlock implements Component {
  private readonly inner: Component
  private width = -1
  private lines: string[] | undefined

  constructor(inner: Component) {
    this.inner = inner
  }

  render(width: number): string[] {
    const cached = this.lines
    if (cached !== undefined && this.width === width) return cached
    const lines = this.inner.render(width)
    this.width = width
    this.lines = lines
    return lines
  }

  update(block: TranscriptBlock): boolean {
    if (!(this.inner instanceof AssistantMessage) || block.kind !== 'assistant') return false
    this.inner.update(block)
    this.lines = undefined
    return true
  }

  invalidate(): void {
    this.lines = undefined
    this.width = -1
    this.inner.invalidate?.()
  }
}

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
    if (key === 'content' && left.kind === 'assistant' && right.kind === 'assistant') {
      if (left.content?.length !== right.content?.length) return false
      if (left.content?.every((part, index) => part.type === right.content?.[index]?.type
        && part.text === right.content[index]?.text)) continue
      return false
    }
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
 * Whether a rebuild would paint exactly what the previous one painted.
 *
 * Frames are scheduled on a cadence, so some rebuilds land with no new event.
 * Comparing the block list keeps those from costing a terminal repaint; a false
 * negative only writes an identical screen.
 * @param left - blocks from the previous rebuild.
 * @param right - blocks from the current rebuild.
 * @returns true when the container would render the same rows.
 */
function sameTranscriptBlocks(left: readonly TranscriptBlock[], right: readonly TranscriptBlock[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!sameTranscriptBlock(left[index]!, right[index]!)) return false
  }
  return true
}

/**
 * Stable identity of one reduced block, for carrying its component across a
 * rebuild. `maxEntries` drops old rows from the front and shifts every later
 * block's index, so index alignment cannot decide reuse. Live assistant rows
 * use the turn/step identity until their durable sequence is assigned.
 * @param block - one reduced block.
 * @returns a key stable for the block's lifetime, or undefined when it has none.
 */
function blockKey(block: TranscriptBlock): string | undefined {
  switch (block.kind) {
    case 'tool': return 'tool:' + block.callId
    case 'compaction': return 'compaction:' + block.compactionId
    case 'assistant': return block.live ? 'live:' + block.streamKey : block.seq === undefined ? undefined : 'assistant:' + String(block.seq)
    case 'user': return block.seq === undefined ? undefined : 'user:' + String(block.seq)
    case 'context': return block.seq === undefined ? undefined : 'context:' + String(block.seq)
    case 'notice': return block.seq === undefined ? undefined : 'notice:' + String(block.seq)
    case 'waiting': return undefined
  }
}

/** Pi-tui renderer for one reduced transcript. */
export class TranscriptRenderer {
  /** The row container: every reduced block, plus the separators between them. */
  readonly container = new Container()
  private entries: readonly TranscriptEntry[] = []
  private extra: readonly TranscriptBlock[] = []
  /** Component per stable block identity from the previous rebuild. */
  private cached = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
  /** Block list from the previous rebuild, for detecting a frame with nothing new. */
  private paintedBlocks: readonly TranscriptBlock[] | undefined
  private changed = false
  private retained = 0
  private liveChars = 0
  private options: TranscriptOptions
  private reducer: ReturnType<typeof createTranscriptReducer>
  private reducedEntries: TranscriptEntry[] = []
  private entryWindow: readonly TranscriptEntry[] | undefined
  /**
   * Separators are stateless, so one instance each serves every block. Reusing
   * them keeps a saturated rebuild from allocating thousands of components per
   * frame, which is what showed up as GC hitches in the stream probe.
   */
  private readonly gap = new Spacer(1)
  private readonly separator: Rule

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

  /** True when the last rebuild changed what the container would paint. */
  get contentChanged(): boolean {
    return this.changed
  }

  /**
   * @param options - reduction and styling options.
   */
  constructor(options: TranscriptOptions) {
    this.options = {
      ...options,
      toolMemory: options.toolMemory ?? {
        settled: new Set(),
        pruned: new Set(),
        prunedSeqs: new Set(),
        callBySeq: new Map(),
      },
    }
    this.reducer = createTranscriptReducer(this.options)
    this.separator = new Rule(this.options.palette.dim)
  }

  /** Switch reasoning/code-execution density and rebuild the existing event window. */
  setDisplayModes(thinkingDisplay: DisplayMode, runCodeDisplay: DisplayMode): void {
    if (this.options.thinkingDisplay === thinkingDisplay && this.options.runCodeDisplay === runCodeDisplay) return
    this.options = { ...this.options, thinkingDisplay, runCodeDisplay }
    // Density is a render option rather than part of TranscriptBlock, so a block
    // can stay equal while its component must switch representation. Drop the
    // reuse window; otherwise the previous density keeps rendering.
    this.cached.clear()
    this.paintedBlocks = undefined
    this.resetReduction()
    this.rebuild()
  }

  /** Toggle file-content previews without reparsing unchanged history components. */
  toggleWritePreview(): void {
    this.options = { ...this.options, writeExpanded: !this.options.writeExpanded }
    for (const [key, cached] of this.cached) {
      if (cached.block.kind === 'tool' && cached.block.name === 'write') this.cached.delete(key)
    }
    this.paintedBlocks = undefined
    this.rebuild()
  }

  /** Change the retained transcript row budget and rebuild. */
  setMaxEntries(maxEntries: number): void {
    this.options = { ...this.options, maxEntries }
    this.resetReduction()
    this.rebuild()
  }

  /**
   * Replace both the event window and local notices in one rebuild.
   * @param entries - contiguous durable and transient event window.
   * @param notices - local notices placed by durable sequence.
   */
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
    this.options.toolMemory?.settled.clear()
    this.options.toolMemory?.pruned.clear()
    this.options.toolMemory?.prunedSeqs.clear()
    this.options.toolMemory?.callBySeq.clear()
    this.cached.clear()
    this.resetReduction()
    this.paintedBlocks = undefined
    this.changed = false
    this.container.clear()
  }

  private resetReduction(): void {
    this.reducer = createTranscriptReducer(this.options)
    this.reducedEntries = []
    this.entryWindow = undefined
  }

  private rebuild(): void {
    const sameWindow = this.entryWindow === this.entries
      && this.reducedEntries[0] === this.entries[0]
      && this.reducedEntries.at(-1) === this.entries[this.reducedEntries.length - 1]
    if (this.reducedEntries.length > this.entries.length
      || !sameWindow && this.reducedEntries.some((entry, index) => entry !== this.entries[index])) this.resetReduction()
    this.entryWindow = this.entries
    const offset = this.reducedEntries.length
    this.reducer.append(this.entries, offset)
    for (let index = offset; index < this.entries.length; index += 1) this.reducedEntries.push(this.entries[index]!)
    const reduction = this.reducer.reduce()
    this.retained = reduction.retainedFrom
    const durable = reduction.blocks
    const anchored = this.extra.filter((notice): notice is TranscriptBlock & { afterSeq: number } => notice.afterSeq !== undefined)
    const trailing = this.extra.filter(notice => notice.afterSeq === undefined)
    const blocks: TranscriptBlock[] = []
    const pending = [...anchored]
    for (const block of durable) {
      while (pending.length > 0) {
        const notice = pending[0]!
        // An assistant row keeps its stream key after settlement, so a notice
        // raised while it was live stays under it. The plain seq test would
        // lift the notice above the row before (and after) that settlement.
        if (notice.afterStreamKey !== undefined && block.kind === 'assistant'
          && block.streamKey === notice.afterStreamKey) break
        if (notice.afterSeq >= (block.seq ?? Number.POSITIVE_INFINITY)) break
        blocks.push(pending.shift()!)
      }
      blocks.push(block)
    }
    blocks.push(...pending, ...trailing)
    this.changed = this.paintedBlocks === undefined || !sameTranscriptBlocks(this.paintedBlocks, blocks)
    if (!this.changed) return
    this.paintedBlocks = blocks
    const next = new Map<string, { readonly block: TranscriptBlock; readonly component: Component }>()
    let liveChars = 0
    this.container.clear()
    for (const [index, block] of blocks.entries()) {
      if (block.kind === 'assistant' && block.live) liveChars += block.text.length + (block.reasoning?.length ?? 0)
      if (index > 0) this.container.addChild(this.gap)
      if (index > 0 && block.kind === 'user') {
        this.container.addChild(this.separator)
        this.container.addChild(this.gap)
      }
      const key = blockKey(block)
      const previous = key === undefined ? undefined : this.cached.get(key)
      // Identity survives window shifts; assistant updates retain completed leaves.
      const component = previous !== undefined && (sameTranscriptBlock(previous.block, block)
        || previous.component instanceof MemoBlock && previous.component.update(block))
        ? previous.component
        : new MemoBlock(renderTranscriptBlock(block, this.options))
      if (key !== undefined) next.set(key, { block, component })
      this.container.addChild(component)
    }
    this.cached = next
    this.liveChars = liveChars
  }
}
