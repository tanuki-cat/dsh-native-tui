import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** Grapheme-safe clipping and slicing for compact previews and bounded values. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const GRAPHEME_CACHE_LIMIT = 8

interface GraphemeEntry {
  count?: number
  readonly segments: string[]
  iterator?: Iterator<Intl.SegmentData>
}

const graphemeCache = new Map<string, GraphemeEntry>()

function entryFor(text: string): GraphemeEntry {
  const cached = graphemeCache.get(text)
  if (cached !== undefined) {
    graphemeCache.delete(text)
    graphemeCache.set(text, cached)
    return cached
  }
  const entry: GraphemeEntry = { segments: [] }
  graphemeCache.set(text, entry)
  if (graphemeCache.size > GRAPHEME_CACHE_LIMIT) {
    const oldest = graphemeCache.keys().next().value
    if (oldest !== undefined) graphemeCache.delete(oldest)
  }
  return entry
}

function graphemeCount(text: string, entry: GraphemeEntry): number {
  if (entry.count !== undefined) return entry.count
  let count = 0
  for (const _segment of graphemeSegmenter.segment(text)) count += 1
  entry.count = count
  return count
}

function graphemePrefix(text: string, limit: number, entry: GraphemeEntry): string {
  if (limit <= 0) return ''
  const segments = entry.segments
  entry.iterator ??= graphemeSegmenter.segment(text)[Symbol.iterator]()
  while (segments.length < limit) {
    const next = entry.iterator.next()
    if (next.done) break
    segments.push(next.value.segment)
  }
  return segments.length <= limit ? segments.join('') : segments.slice(0, limit).join('')
}

/** Clip a reasoning preview at a grapheme boundary. */
export function clipGraphemes(text: string, limit: number): string {
  const entry = entryFor(text)
  const total = graphemeCount(text, entry)
  if (total <= limit) return text
  return graphemePrefix(text, limit, entry) + `\n… [${String(total - limit)} chars omitted]`
}

/** Count the grapheme clusters in a string. */
export function graphemesOf(text: string): readonly string[] {
  return [...graphemeSegmenter.segment(text)].map(segment => segment.segment)
}

/**
 * Clip a preview to a display-column budget, keeping the omission marker on
 * the same row.
 *
 * A grapheme budget alone lets 240 CJK clusters occupy 480 columns, which
 * wraps a one-line compact preview across several transcript rows. The marker
 * is sized first so the result never exceeds `maxWidth` columns.
 * @param text - preview text, expected to be one line.
 * @param maxWidth - maximum visible columns.
 * @returns text that fits the budget, with an inline omission marker.
 */
export function clipTextToWidth(text: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth))
  if (width === 0) return ''
  if (visibleWidth(text) <= width) return text
  const total = graphemesOf(text).length
  const marker = ` … [${String(total)} chars omitted]`
  const markerWidth = visibleWidth(marker)
  if (markerWidth >= width) return truncateToWidth(text, width, '…')
  const kept = truncateToWidth(text, width - markerWidth, '')
  const omitted = total - graphemesOf(kept).length
  return kept + ` … [${String(omitted)} chars omitted]`
}

/**
 * Slice a string at a grapheme boundary without splitting a surrogate pair.
 *
 * The limit stays a UTF-16 length budget so existing call sites keep their
 * character caps; a grapheme that would cross the budget is dropped whole.
 * @param text - source text.
 * @param limit - maximum UTF-16 code units to keep.
 * @param keep - end of the text that survives.
 * @returns the bounded slice.
 */
export function sliceGraphemes(text: string, limit: number, keep: 'start' | 'end' = 'start'): string {
  const budget = Math.max(0, Math.floor(limit))
  if (budget === 0) return ''
  if (text.length <= budget) return text
  if (keep === 'start') {
    let used = 0
    let kept = ''
    for (const { segment } of graphemeSegmenter.segment(text)) {
      if (used + segment.length > budget) break
      kept += segment
      used += segment.length
    }
    return kept
  }
  const segments = graphemesOf(text)
  let used = 0
  let kept = ''
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!
    if (used + segment.length > budget) break
    kept = segment + kept
    used += segment.length
  }
  return kept
}
