/**
 * Schema-driven helpers for Host settings forms.
 *
 * The Host publishes each plugin's schemastery form as a JSON envelope with a
 * `uid`/`refs` table. These helpers resolve that envelope into typed field
 * specs, format and validate terminal input, and turn staged edits into the
 * path operations the settings service applies.
 *
 * @module dsh-native-tui/runtime/settings
 */

/** One path-addressed settings edit, matching the Host service shape. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** A typed view of one schema node. */
export type SettingsFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'const'
  | 'union'
  | 'object'
  | 'array'
  | 'dict'
  | 'unknown'

/** One declared field below a settings object. */
export interface SettingsFieldSpec {
  /** Field name at this level. */
  readonly name: string
  /** Schemastery node type. */
  readonly type: SettingsFieldType
  /** Schema description, when the owner declares one. */
  readonly description?: string
  /** Schema default value. */
  readonly defaultValue?: unknown
  /** Whether the schema requires the field. */
  readonly required: boolean
  /** Whether the owner marks this slot secret. */
  readonly secret: boolean
  /** Allowed values for const/union-of-const nodes. */
  readonly options?: readonly (string | number | boolean | null)[]
  /** Declared children for object nodes. */
  readonly children?: readonly SettingsFieldSpec[]
  /** Item schema for array/dict nodes. */
  readonly item?: SettingsFieldSpec
  /** Whether an object/dict node accepts arbitrary keys rather than declared ones. */
  readonly dynamic: boolean
  /** Numeric lower bound. */
  readonly min?: number
  /** Numeric upper bound. */
  readonly max?: number
  /** Numeric step; 1 means an integer field. */
  readonly step?: number
  /** The resolved schemastery node, for callers that need raw metadata. */
  readonly raw: Record<string, unknown>
}

/** One staged edit in a settings form. */
export interface SettingsPathChange {
  readonly path: readonly string[]
  /** Remove the user override and fall back to the inherited value. */
  readonly unset?: boolean
  /** Replacement value when `unset` is not set. */
  readonly value?: unknown
}

/** A parsed terminal input, or the reason it was refused. */
export type SettingsParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

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

function fieldType(node: Record<string, unknown> | undefined): SettingsFieldType {
  const type = node?.type
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'const'
    || type === 'union' || type === 'object' || type === 'array' || type === 'dict') {
    return type
  }
  return 'unknown'
}

function metaOf(node: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = node?.meta
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {}
}

function optionsOf(node: Record<string, unknown> | undefined, refs: Record<string, unknown> | undefined, depth = 0): readonly (string | number | boolean | null)[] | undefined {
  if (node === undefined || depth > 8) return undefined
  const type = fieldType(node)
  if (type === 'const') return [node.value as string | number | boolean | null]
  if (type !== 'union') return undefined
  const list = node.list
  if (!Array.isArray(list)) return undefined
  const values: (string | number | boolean | null)[] = []
  for (const entry of list) {
    const resolved = resolveNode(entry, refs)
    const nested = optionsOf(resolved, refs, depth + 1)
    if (nested === undefined) return undefined
    values.push(...nested)
  }
  return values
}

function specOf(name: string, rawNode: Record<string, unknown> | undefined, refs: Record<string, unknown> | undefined): SettingsFieldSpec {
  const node = rawNode ?? {}
  const meta = metaOf(node)
  const type = fieldType(node)
  const children = type === 'object'
    ? Object.entries((node.dict !== null && typeof node.dict === 'object' && !Array.isArray(node.dict))
      ? node.dict as Record<string, unknown>
      : {}).map(([key, child]) => specOf(key, resolveNode(child, refs), refs))
    : undefined
  const itemNode = (type === 'array' || type === 'dict') ? resolveNode(node.inner, refs) : undefined
  const options = optionsOf(node, refs)
  return {
    name,
    type,
    ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    ...(meta.default === undefined ? {} : { defaultValue: meta.default }),
    required: meta.required === true,
    secret: meta.role === 'secret',
    ...(options === undefined ? {} : { options }),
    ...(children === undefined ? {} : { children }),
    ...(itemNode === undefined ? {} : { item: specOf('item', itemNode, refs) }),
    dynamic: type === 'dict' || (type === 'object' && (children === undefined || children.length === 0)),
    ...(typeof meta.min === 'number' ? { min: meta.min } : {}),
    ...(typeof meta.max === 'number' ? { max: meta.max } : {}),
    ...(typeof meta.step === 'number' ? { step: meta.step } : {}),
    raw: node,
  }
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

/**
 * Resolve one schema node by object-key path.
 * @param schema - schemastery JSON envelope.
 * @param path - object keys from the top level.
 * @returns the resolved node, or undefined when the path is not declared.
 */
export function settingsFieldAt(schema: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  const refs = refsOf(schema)
  let node = resolveNode(schema, refs)
  for (const segment of path) {
    if (node === undefined) return undefined
    const dict = node.dict
    if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return undefined
    node = resolveNode((dict as Record<string, unknown>)[segment], refs)
  }
  return node
}

/**
 * Declared fields of the root settings object.
 * @param schema - schemastery JSON envelope.
 * @returns typed specs in schema order.
 */
export function settingsFormFields(schema: unknown): readonly SettingsFieldSpec[] {
  const refs = refsOf(schema)
  const top = resolveNode(schema, refs)
  const dict = top?.dict !== null && typeof top?.dict === 'object' && !Array.isArray(top.dict)
    ? top.dict as Record<string, unknown>
    : undefined
  return nodeFields(top).map(name => specOf(name, resolveNode(dict?.[name], refs), refs))
}

/**
 * Declared children below one object node.
 * @param schema - schemastery JSON envelope.
 * @param path - object keys from the top level.
 * @returns typed specs, or an empty list when the node has no declared children.
 */
export function settingsFormChildren(schema: unknown, path: readonly string[]): readonly SettingsFieldSpec[] {
  const refs = refsOf(schema)
  const node = settingsFieldAt(schema, path)
  if (node === undefined) return []
  const dict = node.dict
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return []
  return Object.entries(dict as Record<string, unknown>).map(([name, child]) => specOf(name, resolveNode(child, refs), refs))
}

/**
 * Build a spec for one node, useful for array items and undeclared values.
 * @param schema - schemastery JSON envelope, used for ref resolution.
 * @param node - resolved node or undefined for an untyped value.
 * @param name - field name to report.
 * @returns the typed spec.
 */
export function settingsSpecOfNode(schema: unknown, node: unknown, name = 'item'): SettingsFieldSpec {
  return specOf(name, resolveNode(node, refsOf(schema)), refsOf(schema))
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

/** Render a path as `field[0].name` for display and search. */
export function settingsPathLabel(path: readonly string[]): string {
  let label = ''
  for (const segment of path) {
    if (/^(?:0|[1-9][0-9]*)$/u.test(segment)) label += '[' + segment + ']'
    else label += label === '' ? segment : '.' + segment
  }
  return label
}

/** Serialize a value for a compact single-line form display. */
export function settingsFormatValue(value: unknown, maxLength = 120): string {
  let text: string
  if (value === undefined) text = '(unset)'
  else if (value === null) text = 'null'
  else if (typeof value === 'string') text = value === '' ? '(empty)' : value.replace(/[\s]+/gu, ' ')
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    }
    catch {
      text = String(value)
    }
  }
  return text.length <= maxLength ? text : text.slice(0, Math.max(0, maxLength - 1)) + '…'
}

/** Whether a field path is a secret slot or lives inside one. */
export function settingsIsSecretPath(secrets: readonly { readonly path: readonly string[] }[] | undefined, path: readonly string[]): boolean {
  if (secrets === undefined) return false
  return secrets.some(secret => secret.path.every((segment, index) => path[index] === segment))
}

/** Whether two JSON-shaped values are equal for change tracking. */
export function settingsValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  catch {
    return false
  }
}

/** Parse one terminal input against a field spec. */
export function settingsParseInput(spec: SettingsFieldSpec, raw: string): SettingsParseResult {
  const text = raw.trim()
  const options = spec.options ?? []
  if ((spec.type === 'const' || spec.type === 'union') && options.length > 0) {
    const match = options.find(option => settingsFormatValue(option, 4096) === text)
    if (match !== undefined) return { ok: true, value: match }
    return { ok: false, error: 'Expected one of: ' + options.map(option => settingsFormatValue(option, 60)).join(', ') }
  }
  if (spec.type === 'boolean') {
    const lower = text.toLowerCase()
    if (lower === 'true' || lower === 'on' || lower === 'yes' || lower === '1') return { ok: true, value: true }
    if (lower === 'false' || lower === 'off' || lower === 'no' || lower === '0') return { ok: true, value: false }
    return { ok: false, error: 'Expected on/off (or true/false).' }
  }
  if (spec.type === 'number') {
    if (text === '') return { ok: false, error: 'Enter a number.' }
    const value = Number(text)
    if (!Number.isFinite(value)) return { ok: false, error: 'Enter a finite number.' }
    if (spec.step === 1 && !Number.isSafeInteger(value)) return { ok: false, error: 'Enter a whole number.' }
    if (spec.min !== undefined && value < spec.min) return { ok: false, error: 'Must be >= ' + String(spec.min) + '.' }
    if (spec.max !== undefined && value > spec.max) return { ok: false, error: 'Must be <= ' + String(spec.max) + '.' }
    return { ok: true, value }
  }
  if (spec.type === 'string') return { ok: true, value: raw }
  if (spec.type === 'array' || spec.type === 'object' || spec.type === 'dict') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch (error) {
      return { ok: false, error: 'Invalid JSON: ' + (error instanceof Error ? error.message : String(error)) }
    }
    if (spec.type === 'array' && !Array.isArray(parsed)) return { ok: false, error: 'Expected a JSON array.' }
    if ((spec.type === 'object' || spec.type === 'dict')
      && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
      return { ok: false, error: 'Expected a JSON object.' }
    }
    return { ok: true, value: parsed }
  }
  if (raw === '') return { ok: false, error: 'Enter a value.' }
  try {
    return { ok: true, value: JSON.parse(raw) }
  }
  catch {
    return { ok: true, value: raw }
  }
}

/**
 * Turn staged edits into ordered path operations.
 * @param changes - staged edits in insertion order.
 * @returns service-ready operations.
 */
export function settingsPathOps(changes: readonly SettingsPathChange[]): SettingsPathOp[] {
  return changes.map(change => change.unset === true
    ? { op: 'unset', path: [...change.path] }
    : { op: 'set', path: [...change.path], value: change.value })
}
