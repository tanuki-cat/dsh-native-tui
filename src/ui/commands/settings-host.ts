/**
 * The inline Host-settings editor.
 *
 * `/settings host` used to print a namespace list and defer editing to
 * `edit|items|set`. This module renders every live namespace as a searchable,
 * schema-driven field list: scalar fields get a typed prompt, arrays expose
 * append/edit/remove, and object or dynamic-record fields fall back to JSON.
 * Writes are path-addressed so editing one leaf never restates (and therefore
 * never deletes) a redacted secret elsewhere in the section.
 *
 * @module dsh-native-tui/ui/commands/settings-host
 */

import type {
  SettingsFieldSpec,
  SettingsFieldType,
  SettingsPathOp,
} from '../../runtime/settings.js'
import {
  settingsFormatValue,
  settingsFormFields,
  settingsIsSecretPath,
  settingsParseInput,
  settingsPathLabel,
  settingsSpecOfNode,
  settingsValueAt,
} from '../../runtime/settings.js'
import { showChoice, showSearchChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import { findSettingsNamespace, writeSettingsOps, type SettingsDescriptor } from './settings-common.js'
import type { SettingsService } from './services.js'
import { errorMessage } from './shared.js'

/** One editable path inside a Host namespace. */
interface HostField {
  readonly path: string[]
  readonly spec: SettingsFieldSpec
  readonly type: SettingsFieldType
  readonly value: unknown
  /** The user layer explicitly sets this path. */
  readonly overridden: boolean
  /** This path or one of its ancestors is a declared secret slot. */
  readonly secret: boolean
  /** Editing the whole value as JSON would restate a secret below it. */
  readonly containsSecret: boolean
  /** This row is an array container. */
  readonly array: boolean
  /** This row addresses one array element. */
  readonly arrayItem: boolean
  /** An enclosing array has no profile override, so index edits would drop inherited items. */
  readonly arrayLocked: boolean
}

/** Whether an object path has an own value, even when it is undefined. */
function hasPath(root: unknown, path: readonly string[]): boolean {
  let current: unknown = root
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return true
}

/** Whether a schema node or any descendant is a secret slot. */
function hasSecretBelow(
  spec: SettingsFieldSpec,
  path: readonly string[],
  secrets: SettingsDescriptor['secrets'],
): boolean {
  if (spec.secret || settingsIsSecretPath(secrets, path)) return true
  if (spec.children?.some(child => hasSecretBelow(child, [...path, child.name], secrets)) === true) return true
  if (spec.item !== undefined && hasSecretBelow(spec.item, [...path, '0'], secrets)) return true
  return false
}

/** Flatten a namespace's schema and value into editable rows. */
export function enumerateHostFields(descriptor: SettingsDescriptor): HostField[] {
  const fields: HostField[] = []
  const visit = (
    spec: SettingsFieldSpec,
    path: string[],
    depth: number,
    value: unknown,
    arrayItem: boolean,
    arrayLocked: boolean,
  ): void => {
    const secret = spec.secret || settingsIsSecretPath(descriptor.secrets, path)
    const overridden = hasPath(descriptor.user, path)
    const containsSecret = hasSecretBelow(spec, path, descriptor.secrets)
    if (depth > 8) {
      fields.push({ path, spec, type: spec.type, value, overridden, secret, containsSecret, array: false, arrayItem, arrayLocked })
      return
    }
    if (spec.type === 'array') {
      fields.push({ path, spec, type: spec.type, value, overridden, secret, containsSecret, array: true, arrayItem, arrayLocked })
      const array = Array.isArray(value) ? value : []
      // Without a profile override, an index write would build a user array
      // from that index alone and drop every inherited element.
      const itemLocked = arrayLocked || !overridden
      for (let index = 0; index < array.length; index += 1) {
        const itemPath = [...path, String(index)]
        const itemSpec = spec.item ?? settingsSpecOfNode(descriptor.schema, undefined)
        const itemValue = array[index]
        fields.push({
          path: itemPath,
          spec: itemSpec,
          type: itemSpec.type,
          value: itemValue,
          overridden: hasPath(descriptor.user, itemPath),
          secret: itemSpec.secret || settingsIsSecretPath(descriptor.secrets, itemPath),
          containsSecret: hasSecretBelow(itemSpec, itemPath, descriptor.secrets),
          array: itemSpec.type === 'array',
          arrayItem: true,
          arrayLocked: itemLocked,
        })
        if (itemSpec.type === 'object' && (itemSpec.children?.length ?? 0) > 0
          && itemValue !== null && typeof itemValue === 'object' && !Array.isArray(itemValue)) {
          for (const child of itemSpec.children ?? []) {
            visit(child, [...itemPath, child.name], depth + 1, settingsValueAt(itemValue, [child.name]), false, itemLocked)
          }
        }
      }
      return
    }
    if (spec.type === 'dict') {
      // A dynamic record is editable as one JSON value and, when its schema
      // declares an entry shape, as concrete child paths too.
      fields.push({ path, spec, type: spec.type, value, overridden, secret, containsSecret, array: false, arrayItem, arrayLocked })
      const record = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
      const item = spec.item
      if (record !== undefined && item !== undefined) {
        for (const [key, childValue] of Object.entries(record)) {
          const childPath = [...path, key]
          if (item.type === 'object' && (item.children?.length ?? 0) > 0) {
            for (const child of item.children ?? []) {
              visit(child, [...childPath, child.name], depth + 1, settingsValueAt(childValue, [child.name]), false, arrayLocked)
            }
          }
          else {
            visit({ ...item, name: key }, childPath, depth + 1, childValue, false, arrayLocked)
          }
        }
      }
      return
    }
    if (spec.type === 'object' && (spec.children?.length ?? 0) > 0
      && (value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)))) {
      for (const child of spec.children ?? []) {
        visit(child, [...path, child.name], depth + 1, settingsValueAt(value, [child.name]), false, arrayLocked)
      }
      return
    }
    fields.push({ path, spec, type: spec.type, value, overridden, secret, containsSecret, array: false, arrayItem, arrayLocked })
  }
  for (const spec of settingsFormFields(descriptor.schema)) {
    visit(spec, [spec.name], 0, settingsValueAt(descriptor.value, [spec.name]), false, false)
  }
  return fields
}

/** One-line summary of a field shown under its path. */
function describeField(field: HostField): string {
  const parts: string[] = [field.type]
  if (field.array) parts.push((Array.isArray(field.value) ? field.value.length : 0) + ' items')
  else if (field.arrayItem) parts.push('array item')
  parts.push('current: ' + settingsFormatValue(field.value, 60))
  if (field.spec.description !== undefined) parts.push(field.spec.description)
  if (field.secret) parts.push('secret · edit in the Web Models page')
  else if (field.overridden) parts.push('profile override')
  return parts.join(' · ')
}

/** Keep a deep path readable in a fixed-width list row. */
function compactPathLabel(path: readonly string[]): string {
  const full = settingsPathLabel(path)
  if (path.length <= 4) return full
  return '…' + settingsPathLabel(path.slice(-4))
}

/** Build the choice rows for one namespace. */
function hostFieldChoices(fields: readonly HostField[], backLabel: string): { value: string; label: string; description: string }[] {
  return [
    { value: '__back__', label: backLabel, description: 'Leave this namespace' },
    ...fields.map((field, index) => ({
      value: 'f' + String(index),
      // The compact label keeps deep paths distinguishable in the narrow
      // column; the full path lives in the description and in search matches.
      label: compactPathLabel(field.path),
      description: settingsPathLabel(field.path) + ' · ' + describeField(field),
    })),
  ]
}

/** Prompt for a typed value; a union/const node becomes a picker. */
async function promptValue(
  ctx: CommandContext,
  spec: SettingsFieldSpec,
  current: unknown,
  title: string,
): Promise<string | undefined> {
  if (spec.options !== undefined && spec.options.length > 0) {
    const keep = settingsFormatValue(current, 200)
    return showChoice(ctx.tui, ctx.palette, title, [
      { value: '__keep__', label: 'Keep current', description: keep },
      ...spec.options.map(option => ({
        value: settingsFormatValue(option, 4096),
        label: settingsFormatValue(option, 60),
        description: 'set this value',
      })),
    ], 'Enter selects · Esc cancels', ctx.signal)
  }
  if (spec.type === 'boolean') {
    return showChoice(ctx.tui, ctx.palette, title, [
      { value: '__keep__', label: 'Keep current', description: settingsFormatValue(current) },
      { value: 'true', label: 'on' },
      { value: 'false', label: 'off' },
    ], 'Enter selects · Esc cancels', ctx.signal)
  }
  const preview = settingsFormatValue(current, 2000)
  const initial = current === undefined
    ? undefined
    : typeof current === 'string' ? current
      : typeof current === 'number' ? String(current)
        : JSON.stringify(current)
  return showTextInput(
    ctx.tui,
    ctx.palette,
    title,
    current === undefined ? 'enter a value' : preview,
    spec.type === 'string'
      ? 'Enter saves · Esc cancels · empty string is allowed'
      : 'Enter saves · Esc cancels · JSON for objects and arrays',
    ctx.signal,
    initial,
    spec.type === 'string',
  )
}

/** Apply one path edit and return the refreshed descriptor. */
async function applyOp(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  descriptor: SettingsDescriptor,
  op: SettingsPathOp,
  message: string,
): Promise<SettingsDescriptor> {
  try {
    const fresh = await writeSettingsOps(settings, ns, [op], descriptor.revision)
    if (fresh === undefined) {
      ctx.notice('warning', 'Namespace "' + ns + '" disappeared while saving.')
      return descriptor
    }
    ctx.notice('info', message)
    return fresh
  }
  catch (error) {
    ctx.notice('error', 'Could not update ' + ns + '. ' + errorMessage(error))
    return descriptor
  }
}

/** Edit one scalar or JSON leaf. */
async function editLeaf(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  descriptor: SettingsDescriptor,
  field: HostField,
): Promise<SettingsDescriptor> {
  const label = settingsPathLabel(field.path)
  if (field.arrayLocked) {
    ctx.notice('warning', 'Field "' + label + '" lives in an inherited array. Open the array and use Edit array as JSON to create a profile override first.')
    return descriptor
  }
  const action = await showChoice(ctx.tui, ctx.palette, 'Host settings · ' + label, [
    { value: 'edit', label: 'Edit value…', description: 'Set one value at this path' },
    ...(field.overridden ? [{ value: 'reset', label: 'Reset to inherited', description: 'Remove the profile override' }] : []),
    { value: 'back', label: 'Back' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (action === undefined || action === 'back') return descriptor
  if (action === 'reset') {
    return applyOp(ctx, settings, ns, descriptor,
      { op: 'unset', path: field.path }, 'Reset ' + ns + '.' + label + ' to the inherited value.')
  }
  const raw = await promptValue(ctx, field.spec, field.value, 'Set ' + ns + '.' + label)
  if (raw === undefined || raw === '__keep__') return descriptor
  const parsed = settingsParseInput(field.spec, raw)
  if (!parsed.ok) {
    ctx.notice('error', 'Invalid value for ' + label + ': ' + parsed.error)
    return descriptor
  }
  return applyOp(ctx, settings, ns, descriptor,
    { op: 'set', path: field.path, value: parsed.value }, 'Updated ' + ns + '.' + label + '.')
}

/** Edit one array element. */
async function editArrayItem(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  descriptor: SettingsDescriptor,
  field: HostField,
): Promise<SettingsDescriptor> {
  const label = settingsPathLabel(field.path)
  if (field.arrayLocked) {
    ctx.notice('warning', 'Item "' + label + '" belongs to an inherited array. Open the array and use Edit array as JSON to create a profile override first.')
    return descriptor
  }
  const action = await showChoice(ctx.tui, ctx.palette, 'Host settings · ' + label, [
    { value: 'edit', label: 'Edit value…', description: describeField(field) },
    { value: 'remove', label: 'Remove item', description: 'Delete this element from the array' },
    { value: 'back', label: 'Back' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (action === undefined || action === 'back') return descriptor
  if (action === 'remove') {
    return applyOp(ctx, settings, ns, descriptor,
      { op: 'unset', path: field.path }, 'Removed ' + ns + '.' + label + '.')
  }
  const raw = await promptValue(ctx, field.spec, field.value, 'Set ' + ns + '.' + label)
  if (raw === undefined || raw === '__keep__') return descriptor
  const parsed = settingsParseInput(field.spec, raw)
  if (!parsed.ok) {
    ctx.notice('error', 'Invalid value for ' + label + ': ' + parsed.error)
    return descriptor
  }
  return applyOp(ctx, settings, ns, descriptor,
    { op: 'set', path: field.path, value: parsed.value }, 'Updated ' + ns + '.' + label + '.')
}

/** Edit one array container. */
async function editArray(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  descriptor: SettingsDescriptor,
  field: HostField,
): Promise<SettingsDescriptor> {
  const label = settingsPathLabel(field.path)
  if (field.arrayLocked) {
    ctx.notice('warning', 'Array "' + label + '" is nested inside an inherited array. Open the outer array and use Edit array as JSON to create a profile override first.')
    return descriptor
  }
  const array = Array.isArray(field.value) ? field.value : []
  const appendBlocked = !field.overridden && field.containsSecret
  const actions = [
    ...(appendBlocked
      ? []
      : [{ value: 'append', label: 'Append item…', description: 'Add one JSON or typed value to the end' }]),
    ...(field.containsSecret ? [] : [{ value: 'json', label: 'Edit array as JSON…', description: 'Replace the whole array' }]),
    ...(field.overridden ? [{ value: 'reset', label: 'Reset to inherited', description: 'Remove the profile override' }] : []),
    { value: 'back', label: 'Back' },
  ]
  const action = await showChoice(ctx.tui, ctx.palette, 'Host settings · ' + label, actions, 'Enter selects · Esc cancels', ctx.signal)
  if (action === undefined || action === 'back') return descriptor
  if (action === 'reset') {
    return applyOp(ctx, settings, ns, descriptor,
      { op: 'unset', path: field.path }, 'Reset ' + ns + '.' + label + ' to the inherited value.')
  }
  const itemSpec = field.spec.item ?? settingsSpecOfNode(descriptor.schema, undefined)
  if (action === 'append') {
    const raw = await promptValue(ctx, itemSpec, undefined, 'Append to ' + ns + '.' + label)
    if (raw === undefined || raw === '__keep__') return descriptor
    const parsed = settingsParseInput(itemSpec, raw)
    if (!parsed.ok) {
      ctx.notice('error', 'Invalid array item: ' + parsed.error)
      return descriptor
    }
    if (!field.overridden) {
      if (field.containsSecret) {
        ctx.notice('warning', 'Array "' + label + '" is inherited and contains secret slots; edit it as JSON is unsafe, so append is unavailable.')
        return descriptor
      }
      // Materialize the effective inherited array plus the new item; an index
      // write against a missing user array would drop the inherited elements.
      return applyOp(ctx, settings, ns, descriptor,
        { op: 'set', path: field.path, value: [...array, parsed.value] },
        'Appended to ' + ns + '.' + label + ' (' + String(array.length + 1) + ' items).')
    }
    return applyOp(ctx, settings, ns, descriptor,
      { op: 'set', path: [...field.path, String(array.length)], value: parsed.value },
      'Appended to ' + ns + '.' + label + ' (' + String(array.length + 1) + ' items).')
  }
  const raw = await promptValue(ctx, field.spec, field.value, 'Set ' + ns + '.' + label + ' as JSON')
  if (raw === undefined || raw === '__keep__') return descriptor
  const parsed = settingsParseInput(field.spec, raw)
  if (!parsed.ok) {
    ctx.notice('error', 'Invalid array for ' + label + ': ' + parsed.error)
    return descriptor
  }
  return applyOp(ctx, settings, ns, descriptor,
    { op: 'set', path: field.path, value: parsed.value }, 'Updated ' + ns + '.' + label + '.')
}

/** Dispatch one selected field to its editor. */
async function editField(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  descriptor: SettingsDescriptor,
  field: HostField,
): Promise<SettingsDescriptor> {
  if (field.secret) {
    ctx.notice('warning', 'Field "' + settingsPathLabel(field.path) + '" is a secret; edit it in the Web Models page, not terminal history.')
    return descriptor
  }
  if ((field.type === 'object' || field.type === 'dict') && field.containsSecret) {
    ctx.notice('warning', 'Field "' + settingsPathLabel(field.path) + '" contains secret slots; edit its leaves individually.')
    return descriptor
  }
  if (field.array) return editArray(ctx, settings, ns, descriptor, field)
  if (field.arrayItem) return editArrayItem(ctx, settings, ns, descriptor, field)
  return editLeaf(ctx, settings, ns, descriptor, field)
}

/** Browse one namespace until the user leaves it. */
async function editNamespace(
  ctx: CommandContext,
  settings: SettingsService,
  ns: string,
  backLabel: string,
): Promise<void> {
  let descriptor = findSettingsNamespace(settings, ns)
  if (descriptor === undefined) {
    ctx.notice('warning', 'No active settings namespace "' + ns + '".')
    return
  }
  for (;;) {
    if (ctx.signal.aborted) return
    const fields = enumerateHostFields(descriptor)
    const pick = await showSearchChoice(
      ctx.tui,
      ctx.palette,
      'Settings · ' + ns,
      hostFieldChoices(fields, backLabel),
      'Enter edits · type to search · Esc back',
      ctx.signal,
    )
    if (pick === undefined || pick === '__back__') return
    const index = Number(pick.slice(1))
    const field = fields[index]
    if (field === undefined) continue
    descriptor = await editField(ctx, settings, ns, descriptor, field)
  }
}

/**
 * Open the Host settings browser; with `ns`, jump straight to that namespace.
 * @param ctx - command context.
 * @param settings - Host settings service.
 * @param ns - namespace to edit directly; omitted opens the namespace list.
 */
export async function openHostSettings(
  ctx: CommandContext,
  settings: SettingsService,
  ns?: string,
): Promise<void> {
  if (ns !== undefined) {
    await editNamespace(ctx, settings, ns, '↩ Back')
    return
  }
  for (;;) {
    if (ctx.signal.aborted) return
    const descriptors = settings.describe({ redactSecrets: true })
    if (descriptors.length === 0) {
      ctx.notice('info', 'No configurable plugin namespaces are active.')
      return
    }
    const pick = await showSearchChoice(
      ctx.tui,
      ctx.palette,
      'Host settings · namespaces',
      descriptors.map(descriptor => ({
        value: descriptor.ns,
        label: descriptor.ns,
        description: Object.keys(descriptor.value).length + ' live fields'
          + (descriptor.secrets !== undefined && descriptor.secrets.length > 0 ? ' · ' + String(descriptor.secrets.length) + ' secrets' : '')
          + ' · applies live',
      })),
      'Enter edits · type to search · Esc closes',
      ctx.signal,
    )
    if (pick === undefined) return
    await editNamespace(ctx, settings, pick, '↩ Back to namespaces')
  }
}
