/**
 * Bounded session-level tool memory for the transcript reducer.
 *
 * The reducer remembers tool identities across window rebuilds so a replay or a
 * late result cannot revive a card whose events were sliced away. Those indexes
 * serve the retained window, not the whole log, so they are capped well above
 * the row budget instead of growing with every historical call.
 *
 * @module dsh-native-tui/ui/transcript-memory
 */

/** One insertion-ordered collection the cap can evict from. */
interface OldestEvictable<K> {
  readonly size: number
  keys(): IterableIterator<K>
  delete(key: K): boolean
}

/**
 * Largest identity memory kept for a row budget.
 *
 * The floor keeps thousands of old calls recognizable while a window rebuild
 * removes them from view; the multiplier keeps a larger configured transcript
 * from evicting identities it can still show.
 * @param maxEntries - retained transcript row budget.
 * @returns the maximum entries per identity collection.
 */
export function toolMemoryLimit(maxEntries: number): number {
  return Math.max(4096, Math.max(0, maxEntries) * 8)
}

/**
 * Drop the oldest entries of one insertion-ordered collection.
 *
 * `keep` lets the caller retain an active identity, such as a pending tool
 * call, while later settled identities are evicted. Iteration is insertion
 * order, so this is FIFO rather than a scan of every historical entry.
 * @param collection - Set or Map with insertion-ordered keys.
 * @param limit - maximum size to keep.
 * @param keep - optional predicate for entries that must survive this pass.
 */
export function capOldest<K>(
  collection: OldestEvictable<K>,
  limit: number,
  keep?: (key: K) => boolean,
): void {
  if (collection.size <= limit) return
  const iterator = collection.keys()
  while (collection.size > limit) {
    const next = iterator.next()
    if (next.done) return
    if (keep?.(next.value) === true) continue
    collection.delete(next.value)
  }
}
