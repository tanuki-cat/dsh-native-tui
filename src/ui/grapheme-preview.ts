/** Grapheme-safe clipping for compact thinking previews. */
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
