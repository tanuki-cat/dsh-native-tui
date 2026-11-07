/**
 * Markdown body that re-renders only its streaming tail.
 *
 * pi-tui's `Markdown` caches on the exact text, so a live assistant message
 * re-parses and re-wraps its whole body on every frame: 50 KB measured ~4.8 ms.
 * Markdown blocks are parsed and wrapped independently, so a completed block
 * renders identically whether it sits at the front of a document or in a
 * component of its own. This component keeps the completed prefix in frozen
 * components and hands only the trailing block to a live one.
 *
 * The split always lands on a blank line outside a fenced code block, and never
 * before an indented line, so list items, quotes and indented continuations are
 * not cut in half. It is abandoned for the rest of the document once a link
 * reference definition appears: those resolve against the whole document, so a
 * definition in one half would be invisible to the other.
 *
 * @module dsh-native-tui/ui/stream-markdown
 */

import { Markdown, type Component, type MarkdownTheme } from '@earendil-works/pi-tui'

/**
 * Shortest body that is worth splitting.
 *
 * Below this the single component is already cheap, and rendering exactly as
 * before keeps short rows free of any split-related difference.
 */
const SPLIT_MIN_CHARS = 4096

/** Frozen chunks grow until this size, so a long message keeps few components. */
const FROZEN_MERGE_CHARS = 8192

/**
 * A link reference definition (`[label]: url`) or footnote definition
 * (`[^note]: …`), indented by at most three spaces.
 *
 * These resolve against the entire document, so a split would hide every
 * definition from the half that does not contain it.
 */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/u

interface FrozenChunk {
  text: string
  readonly component: Markdown
}

/** One markdown block boundary this component has found. */
interface ScanState {
  /** Offset after the last complete source line that was inspected. */
  scanned: number
  inFence: boolean
  /** Offset after a blank line that a following block may start at. */
  pendingBlank: number | undefined
  /** Offset the frozen prefix currently ends at. */
  split: number
  /** Set once the document defines a link reference; splitting stops for good. */
  definesReference: boolean
}

/**
 * One markdown document whose completed prefix is rendered once.
 *
 * The output matches `new Markdown(text, 0, 0, theme).render(width)` line for
 * line: blocks are independent, one blank line separates the frozen components
 * from the live one exactly as it separates blocks inside a single component,
 * and a document that defines link references is rendered whole.
 */
export class StreamMarkdown implements Component {
  private text: string
  private liveText = ''
  private readonly live: Markdown
  private readonly frozen: FrozenChunk[] = []
  private frozenText = ''
  /** Render the document as one component: it defines link references. */
  private whole = false
  private scan: ScanState = { scanned: 0, inFence: false, pendingBlank: undefined, split: 0, definesReference: false }
  private width = -1
  private lines: string[] | undefined

  /**
   * @param text - initial markdown source.
   * @param theme - markdown theme shared with the frozen components.
   */
  constructor(text: string, private readonly theme: MarkdownTheme) {
    this.text = text
    this.live = new Markdown(text, 0, 0, theme)
    this.liveText = text
    this.sync()
  }

  /**
   * Replace the source. An append keeps the frozen prefix and the scan position.
   * @param text - the complete new source, not a delta.
   */
  setText(text: string): void {
    if (text === this.text) return
    if (!text.startsWith(this.text)) this.reset()
    this.text = text
    this.sync()
    this.lines = undefined
  }

  render(width: number): string[] {
    if (this.lines !== undefined && this.width === width) return this.lines
    this.width = width
    const lines: string[] = []
    for (const chunk of this.frozen) {
      for (const line of chunk.component.render(width)) lines.push(line)
    }
    const live = this.live.render(width)
    // One blank line separates adjacent blocks. A frozen chunk whose source ended
    // with a blank line already renders that separator, so only add a missing one.
    if (live.length > 0 && lines.length > 0 && (lines.at(-1) ?? '').trim() !== '') {
      lines.push(' '.repeat(Math.max(0, width)))
    }
    for (const line of live) lines.push(line)
    this.lines = lines
    return lines
  }

  invalidate(): void {
    this.lines = undefined
    for (const chunk of this.frozen) chunk.component.invalidate()
    this.live.invalidate()
  }

  /**
   * Drop every cached component and start the scan over.
   *
   * Only a replaced source needs this; an append keeps both. The caller must
   * re-run {@link sync}, which rescans the whole document once.
   */
  private reset(): void {
    this.frozen.length = 0
    this.frozenText = ''
    this.whole = false
    this.scan = { scanned: 0, inFence: false, pendingBlank: undefined, split: 0, definesReference: false }
  }

  /** Extend the block scan, then move text between the frozen prefix and the live tail. */
  private sync(): void {
    this.scanBlocks()
    if (this.scan.definesReference) this.whole = true
    if (this.whole) {
      this.dropFrozen()
      // The live component owns the whole document, definitions included.
      if (this.text !== this.liveText) {
        this.liveText = this.text
        this.live.setText(this.text)
      }
      return
    }
    const split = this.text.length >= SPLIT_MIN_CHARS ? this.scan.split : 0
    const prefix = this.text.slice(0, split)
    // A split that moved backwards cannot reuse the chunks it already froze.
    if (!prefix.startsWith(this.frozenText)) this.dropFrozen()
    if (prefix.length > this.frozenText.length) {
      const chunk = prefix.slice(this.frozenText.length)
      const last = this.frozen.at(-1)
      if (last !== undefined && last.text.length + chunk.length <= FROZEN_MERGE_CHARS) {
        last.text += chunk
        last.component.setText(last.text)
      }
      else {
        this.frozen.push({ text: chunk, component: new Markdown(chunk, 0, 0, this.theme) })
      }
      this.frozenText = prefix
    }
    const live = this.text.slice(split)
    if (live !== this.liveText) {
      this.liveText = live
      this.live.setText(live)
    }
  }

  /** Forget the frozen prefix without disturbing the scan. */
  private dropFrozen(): void {
    this.frozen.length = 0
    this.frozenText = ''
  }

  /**
   * Inspect the source lines that appended since the last call.
   *
   * A fence toggles on a fence line, a blank line outside a fence is a block
   * boundary, and the offset is only remembered once the next line is
   * unindented — an indented line continues the block above it. A reference
   * definition disables splitting for the rest of the document.
   */
  private scanBlocks(): void {
    const complete = this.text.lastIndexOf('\n') + 1
    let index = this.scan.scanned
    while (index < complete) {
      const end = this.text.indexOf('\n', index) + 1
      const line = this.text.slice(index, Math.max(index, end - 1))
      const trimmed = line.trimStart()
      if (!this.scan.inFence && REFERENCE_DEFINITION.test(line)) this.scan.definesReference = true
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        this.scan.inFence = !this.scan.inFence
        this.scan.pendingBlank = undefined
      }
      else if (!this.scan.inFence && trimmed === '') {
        this.scan.pendingBlank = end
      }
      else if (this.scan.pendingBlank !== undefined) {
        const pending = this.scan.pendingBlank
        this.scan.pendingBlank = undefined
        if (!this.scan.inFence && line[0] !== ' ' && line[0] !== '\t') this.scan.split = pending
      }
      index = end
    }
    this.scan.scanned = complete
  }
}
