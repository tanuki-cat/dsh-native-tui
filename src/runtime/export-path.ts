/**
 * A free name for an export the operator did not name itself.
 *
 * `/export` refuses to overwrite an existing file, which is the right default
 * for a path the operator typed. A default name derived from the Session id is
 * not that: exporting the same Session twice used to fail on the first one's
 * file, so the default now walks to the first free `-1`, `-2` … variant and the
 * atomic create still owns the final decision.
 *
 * @module dsh-native-tui/runtime/export-path
 */
import { access } from 'node:fs/promises'
import { extname } from 'node:path'

/** Distinct names tried before the caller's own write reports the collision. */
const MAX_SUFFIX = 100

/** Whether a path is already taken; only a missing path counts as free. */
async function taken(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

/**
 * Find the first free name for one default export path.
 * @param path - absolute path the default name would use.
 * @returns the given path when free, otherwise the same stem with a counter
 *   inserted before its extension. The original path is returned once no
 *   candidate is free, so the caller's exclusive write reports the collision.
 */
export async function availableExportPath(path: string): Promise<string> {
  const extension = extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let index = 0; index < MAX_SUFFIX; index += 1) {
    const candidate = index === 0 ? path : stem + '-' + String(index) + extension
    if (!await taken(candidate)) return candidate
  }
  return path
}
