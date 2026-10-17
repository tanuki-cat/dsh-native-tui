function refsOf(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  const refs = (schema as { readonly refs?: unknown }).refs
  return refs !== null && typeof refs === 'object' && !Array.isArray(refs)
    ? refs as Record<string, unknown>
    : undefined
}

function resolveNode(schema: unknown, refs?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof schema === 'number' || typeof schema === 'string') {
    const resolved = refs?.[String(schema)]
    return resolved !== null && typeof resolved === 'object' ? resolved as Record<string, unknown> : undefined
  }
  if (schema === null || typeof schema !== 'object') return undefined
  const envelope = schema as {
    readonly uid?: unknown
    readonly refs?: unknown
  }
  const localRefs = refsOf(schema) ?? refs
  const uid = typeof envelope.uid === 'string'
    ? envelope.uid
    : typeof envelope.uid === 'number' ? String(envelope.uid) : undefined
  if (uid !== undefined && localRefs !== undefined) {
    return resolveNode(localRefs[uid], localRefs)
  }
  return schema as Record<string, unknown>
}

function nodeFields(node: Record<string, unknown> | undefined): string[] {
  if (node === undefined) return []
  const dict = node.dict
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return []
  return Object.keys(dict)
}

/** Top-level live-field names from one schemastery JSON envelope. */
export function settingsFields(schema: unknown): string[] {
  return nodeFields(resolveNode(schema, refsOf(schema)))
}

/**
 * Child field names below an object path.
 * @param schema - schemastery JSON envelope.
 * @param path - object keys from the top level.
 * @returns child field names, or an empty list when the path is missing or not an object.
 */
export function settingsChildFields(schema: unknown, path: readonly string[]): string[] {
  const refs = refsOf(schema)
  let node = resolveNode(schema, refs)
  for (const segment of path) {
    if (node === undefined) return []
    const dict = node.dict
    if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return []
    node = resolveNode((dict as Record<string, unknown>)[segment], refs)
  }
  return nodeFields(node)
}

/** Read one value from a settings object by path. */
export function settingsValueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Set one value in a settings object, creating missing object nodes.
 * @param root - object to mutate (usually a deep clone).
 * @param path - non-empty object key path.
 * @param value - leaf value.
 * @returns the same root object.
 */
export function settingsSetAt(root: unknown, path: readonly string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) throw new Error('settings path must not be empty')
  let current: Record<string, unknown>
  if (root === null || typeof root !== 'object' || Array.isArray(root)) current = {}
  else current = root as Record<string, unknown>
  const result = current
  for (const segment of path.slice(0, -1)) {
    const next = current[segment]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
    } else {
      current = next as Record<string, unknown>
    }
  }
  current[path.at(-1)!] = value
  return result
}