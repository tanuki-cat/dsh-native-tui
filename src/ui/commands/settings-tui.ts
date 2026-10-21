/**
 * The guided native-terminal settings page.
 *
 * Every field the plugin declares is listed with its current effective value,
 * a plain-language description, and when the value takes effect. Edits are
 * staged in the page; `Save and apply` writes them as one path-addressed
 * settings mutation, so a revision conflict cannot leave half a form behind.
 *
 * @module dsh-native-tui/ui/commands/settings-tui
 */

import { isAbsolute } from 'node:path'
import type { ResolvedConfig } from '../../config.js'
import type { SettingsPathOp } from '../../runtime/settings.js'
import { settingsValuesEqual } from '../../runtime/settings.js'
import { showChoice } from '../dialogs.js'
import {
  SETTINGS_RESET,
  settingsChoiceSubmenu,
  settingsInputSubmenu,
  showSettingsPanel,
  type SettingsPanelAction,
  type SettingsPanelContext,
  type SettingsPanelItem,
} from '../settings-panel.js'
import type { CommandContext } from './context.js'
import {
  findSettingsNamespace,
  writeSettingsOps,
  type SettingsDescriptor,
} from './settings-common.js'
import { openHostSettings } from './settings-host.js'
import type { AgentPresetsService, SettingsService } from './services.js'
import { errorMessage, NL } from './shared.js'

/** When one terminal setting takes effect. */
export type TuiApply = 'live' | 'restart' | 'next-launch'

/** How a terminal setting is edited. */
type TuiKind = 'choice' | 'boolean' | 'number' | 'text'

/** One terminal setting the guided page owns. */
export interface TuiSetting {
  /** Profile config key. */
  readonly key: string
  readonly label: string
  readonly section: 'Display' | 'Terminal' | 'Session'
  /** One-sentence explanation shown under the row. */
  readonly description: string
  readonly apply: TuiApply
  readonly kind: TuiKind
  readonly options?: readonly string[]
  /** Text shown when the effective value is undefined. */
  readonly emptyLabel?: string
  readonly placeholder: string
  /** Effective value used when the profile declares none. */
  readonly fallback: (descriptor: SettingsDescriptor, config: ResolvedConfig) => unknown
  /** Validate a non-empty text/number input. */
  readonly validate?: (value: string) => string | undefined
}

const APPLY_LABEL: Record<TuiApply, string> = {
  live: 'live',
  restart: 'restart',
  'next-launch': 'next launch',
}

const DISPLAY_MODES = ['hidden', 'compact', 'detailed'] as const
const THEMES = ['auto', 'dark', 'light', 'plain'] as const

/** Every editable terminal setting, in page order. */
export const TUI_SETTINGS: readonly TuiSetting[] = [
  {
    key: 'thinkingDisplay',
    label: 'Thinking display',
    section: 'Display',
    description: 'Reasoning blocks render as hidden, a compact one-line preview, or the full block.',
    apply: 'live',
    kind: 'choice',
    options: DISPLAY_MODES,
    placeholder: 'hidden | compact | detailed',
    fallback: descriptor => (descriptor.value.showReasoning === false ? 'hidden' : 'detailed'),
  },
  {
    key: 'runCodeDisplay',
    label: 'Code execution',
    section: 'Display',
    description: 'run_code, bash, and pwsh calls render as hidden, a summary, or full arguments and output.',
    apply: 'live',
    kind: 'choice',
    options: DISPLAY_MODES,
    placeholder: 'hidden | compact | detailed',
    fallback: () => 'detailed',
  },
  {
    key: 'showReasoning',
    label: 'Show reasoning (legacy)',
    section: 'Display',
    description: 'Legacy switch used only while Thinking display has no explicit value. Prefer Thinking display.',
    apply: 'live',
    kind: 'boolean',
    placeholder: 'on | off',
    fallback: () => true,
  },
  {
    key: 'maxTranscriptEntries',
    label: 'Transcript entries',
    section: 'Display',
    description: 'Maximum entries kept in the terminal view; older entries scroll out of the retained window. Higher values cost a slower stream frame.',
    apply: 'live',
    kind: 'number',
    placeholder: 'integer >= 50',
    fallback: () => 600,
    validate: value => {
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed < 50) return 'Enter a whole number >= 50.'
      return undefined
    },
  },
  {
    key: 'theme',
    label: 'Theme',
    section: 'Terminal',
    description: 'ANSI palette: auto follows the terminal, plain disables styling.',
    apply: 'restart',
    kind: 'choice',
    options: THEMES,
    placeholder: 'auto | dark | light | plain',
    fallback: () => 'auto',
  },
  {
    key: 'fullscreen',
    label: 'Fullscreen',
    section: 'Terminal',
    description: 'Use the alternate screen with application-owned scrolling and mouse support.',
    apply: 'restart',
    kind: 'boolean',
    placeholder: 'on | off',
    fallback: () => false,
  },
  {
    key: 'title',
    label: 'Header title',
    section: 'Terminal',
    description: 'Product title shown above the transcript and in the status row.',
    apply: 'live',
    kind: 'text',
    emptyLabel: 'DeepSeek Harness',
    placeholder: 'DeepSeek Harness',
    fallback: () => 'DeepSeek Harness',
  },
  {
    key: 'cwd',
    label: 'Working directory',
    section: 'Session',
    description: 'Directory for a new session and relative file commands. Applies to the next launch.',
    apply: 'next-launch',
    kind: 'text',
    emptyLabel: '(process cwd)',
    placeholder: '/absolute/path',
    fallback: (_descriptor, config) => config.cwd,
    validate: value => isAbsolute(value) ? undefined : 'Enter an absolute directory path.',
  },
  {
    key: 'sessionId',
    label: 'Resume session',
    section: 'Session',
    description: 'Open this persisted session on the next launch instead of creating a new one.',
    apply: 'next-launch',
    kind: 'text',
    emptyLabel: '(new session)',
    placeholder: 'native-tui-…',
    fallback: () => undefined,
    validate: value => /\s/u.test(value) ? 'Session ids cannot contain whitespace.' : undefined,
  },
  {
    key: 'agentPreset',
    label: 'Agent preset',
    section: 'Session',
    description: 'Agent preset used for a new session. The preset registry default stands in while empty.',
    apply: 'next-launch',
    kind: 'text',
    emptyLabel: '(registry default)',
    placeholder: 'preset id',
    fallback: () => undefined,
    validate: value => /\s/u.test(value) ? 'Preset ids cannot contain whitespace.' : undefined,
  },
]

/** One staged field change. */
export type TuiStagedValue = { readonly unset: true } | { readonly unset?: false; readonly value: unknown }

/** Context lines the page adds to the session fields when the Host has data. */
interface GuidedHints {
  readonly sessions: readonly string[]
  readonly presets: readonly string[]
}

/** Fetch stored sessions and presets for the guidance hints. */
async function loadHints(ctx: CommandContext): Promise<GuidedHints> {
  const sessions: string[] = []
  const presets: string[] = []
  try {
    const persistence = ctx.host.get('sessionPersistence') as {
      list(): Promise<readonly { header: { id: string; createdAt: number } }[]>
    } | undefined
    if (persistence !== undefined) {
      const rows = await persistence.list()
      rows
        .map(row => row.header)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 3)
        .forEach(row => { sessions.push(row.id) })
    }
  }
  catch {
    // A missing listing only drops a hint, never the setting.
  }
  try {
    const registry = ctx.host.get('agentPresets') as AgentPresetsService | undefined
    if (registry !== undefined) {
      for (const preset of await registry.list()) presets.push(preset.id)
    }
  }
  catch {
    // Same as above: hints are optional.
  }
  return { sessions, presets }
}

/** Effective field value, preferring the descriptor and falling back to runtime defaults. */
function baselineOf(setting: TuiSetting, descriptor: SettingsDescriptor, config: ResolvedConfig): unknown {
  const value = descriptor.value[setting.key]
  return value === undefined ? setting.fallback(descriptor, config) : value
}

/** Whether the profile patch carries an explicit value for one field. */
function isOverridden(setting: TuiSetting, descriptor: SettingsDescriptor): boolean {
  const user = descriptor.user
  return user !== null && typeof user === 'object' && Object.hasOwn(user, setting.key)
}

/** Render one field value for the list. */
function formatSetting(setting: TuiSetting, value: unknown): string {
  if (value === undefined || value === '') return setting.emptyLabel ?? '(unset)'
  if (setting.kind === 'boolean') return value === true ? 'on' : 'off'
  return String(value)
}

/** Text prefill for an input submenu; optional fields start empty when unset. */
function initialText(setting: TuiSetting, baseline: unknown): string | undefined {
  if (baseline === undefined || baseline === '') return undefined
  return String(baseline)
}

/** One-line guidance for fields whose valid values live in a Host registry. */
function fieldDescription(setting: TuiSetting, overridden: boolean, hints: GuidedHints): string {
  const parts = [setting.section + ' · ' + APPLY_LABEL[setting.apply], setting.description]
  if (setting.key === 'sessionId' && hints.sessions.length > 0) {
    parts.push('Recent: ' + hints.sessions.join(', '))
  }
  if (setting.key === 'agentPreset' && hints.presets.length > 0) {
    parts.push('Available: ' + hints.presets.slice(0, 5).join(', '))
  }
  if (overridden) parts.push('Overridden in the profile.')
  return parts.join(' · ')
}

/** Description line for the action rows. */
function pendingLabel(count: number): string {
  return count === 0 ? 'no pending changes' : String(count) + ' pending change' + (count === 1 ? '' : 's')
}

/** Build one field's value submenu. */
function fieldSubmenu(
  context: SettingsPanelContext,
  setting: TuiSetting,
  current: () => unknown,
  defaultText: string,
  done: (value?: string) => void,
): ReturnType<NonNullable<SettingsPanelItem['submenu']>> {
  const value = current()
  const options = setting.kind === 'choice'
    ? [...(setting.options ?? [])]
    : setting.kind === 'boolean' ? ['on', 'off'] : undefined
  if (options !== undefined) {
    return settingsChoiceSubmenu(
      context.palette,
      setting.label,
      [
        ...options.map(option => ({
          value: option,
          label: option,
          description: option === formatSetting(setting, value) ? 'current · ' + APPLY_LABEL[setting.apply] : 'set · ' + APPLY_LABEL[setting.apply],
        })),
        { value: SETTINGS_RESET, label: 'Use default', description: 'Remove the saved override; effective value: ' + defaultText },
      ],
      next => { done(next) },
      () => { done() },
      'Enter selects · Esc back',
      formatSetting(setting, value),
    )
  }
  return settingsInputSubmenu({
    palette: context.palette,
    title: setting.label,
    placeholder: setting.placeholder,
    hint: 'Enter saves · Esc back · empty restores the default · applies ' + APPLY_LABEL[setting.apply],
    initialValue: initialText(setting, value),
    validate: next => next === '' ? undefined : setting.validate?.(next),
    onSubmit: next => { done(next) },
    onCancel: () => { done() },
  })
}

/** Build one action submenu that leaves the page after confirmation. */
function actionSubmenu(
  context: SettingsPanelContext,
  title: string,
  confirmLabel: string,
  confirmDescription: string,
  action: SettingsPanelAction,
  done: (value?: string) => void,
): ReturnType<NonNullable<SettingsPanelItem['submenu']>> {
  return settingsChoiceSubmenu(
    context.palette,
    title,
    [
      { value: 'confirm', label: confirmLabel, description: confirmDescription },
      { value: 'cancel', label: 'Keep editing' },
    ],
    value => {
      done()
      if (value === 'confirm') context.finish(action)
    },
    () => { done() },
  )
}

/**
 * Apply one SettingsList value to the staged draft.
 *
 * The submenus already validated typed input; this function owns the policy
 * that makes a change a real change: resets remove the profile override, and a
 * value equal to the effective default is not staged for a field that has no
 * override.
 * @returns the text the list should show after the change.
 */
export function applyTuiSettingInput(
  draft: Map<string, TuiStagedValue>,
  setting: TuiSetting,
  baseline: unknown,
  overridden: boolean,
  value: string,
): string {
  const reset = value === SETTINGS_RESET || ((setting.kind === 'text' || setting.kind === 'number') && value === '')
  if (reset) {
    if (overridden) draft.set(setting.key, { unset: true })
    else draft.delete(setting.key)
    return formatSetting(setting, baseline)
  }
  const parsed = setting.kind === 'boolean' ? value === 'on' : setting.kind === 'number' ? Number(value) : value
  if (!overridden && settingsValuesEqual(parsed, baseline)) draft.delete(setting.key)
  else draft.set(setting.key, { value: parsed })
  return formatSetting(setting, parsed)
}

/** One staged field change carried by the save receipt. */
export interface TuiSaveChange {
  readonly setting: TuiSetting
  readonly staged: TuiStagedValue
}

/** Render the staged change as a one-line summary for the save receipt. */
function changeSummary(changes: readonly TuiSaveChange[]): string {
  const applied = new Map<TuiApply, string[]>()
  for (const { setting } of changes) {
    const list = applied.get(setting.apply) ?? []
    list.push(setting.key)
    applied.set(setting.apply, list)
  }
  const parts = [...applied.entries()].map(([apply, keys]) => keys.join(', ') + ' (' + APPLY_LABEL[apply] + ')')
  return parts.join(' · ')
}

/**
 * Build the notice for one successful save, including the fields that only
 * take effect after a restart or on the next launch.
 * @param changes - staged fields that were written.
 * @returns the receipt text.
 */
export function settingsSaveReceipt(changes: readonly TuiSaveChange[]): string {
  return 'Saved TUI settings: ' + changeSummary(changes) + '.' + restartHint(changes)
}

/** Ask before throwing away staged edits. */
async function confirmDiscard(ctx: CommandContext, count: number): Promise<boolean> {
  const choice = await showChoice(ctx.tui, ctx.palette, 'Discard changes?', [
    { value: 'discard', label: 'Discard ' + pendingLabel(count), description: 'Close without writing the profile patch' },
    { value: 'keep', label: 'Keep editing', description: 'Return to the settings page' },
  ], 'Enter selects · Esc keeps editing', ctx.signal)
  return choice === 'discard'
}

/**
 * Open the guided terminal settings page until the user closes it.
 * @param ctx - command context.
 */
export async function openTuiSettings(ctx: CommandContext): Promise<void> {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const hints = await loadHints(ctx)
  const draft = new Map<string, TuiStagedValue>()
  for (;;) {
    if (ctx.signal.aborted) return
    const descriptor = findSettingsNamespace(settings, 'native-tui')
    if (descriptor === undefined) {
      ctx.notice('warning', 'native-tui settings are not registered in this profile; edit the profile config instead.')
      return
    }
    const baseline = new Map<string, unknown>()
    for (const setting of TUI_SETTINGS) baseline.set(setting.key, baselineOf(setting, descriptor, ctx.config))
    /** Latest staged value for one field, or the descriptor baseline. */
    const stagedValue = (setting: TuiSetting): unknown => {
      const staged = draft.get(setting.key)
      if (staged === undefined) return baseline.get(setting.key)
      return staged.unset === true ? baseline.get(setting.key) : staged.value
    }
    const action = await showSettingsPanel(ctx.tui, ctx.palette, context => ({
      title: () => 'TUI settings · ' + pendingLabel(draft.size),
      hint: 'Enter/Space changes a value · type to search · Save and apply writes the profile · Esc closes',
      items: [
        ...TUI_SETTINGS.map((setting): SettingsPanelItem => ({
          id: setting.key,
          label: setting.label,
          description: fieldDescription(setting, isOverridden(setting, descriptor), hints),
          value: formatSetting(setting, stagedValue(setting)),
          submenu: (_current, done) => fieldSubmenu(
            context,
            setting,
            () => stagedValue(setting),
            formatSetting(setting, setting.fallback(descriptor, ctx.config)),
            done,
          ),
        })),
        {
          id: '__host__',
          label: 'Host settings…',
          description: 'Browse every live plugin namespace with the same schema-driven editor.',
          value: 'namespaces',
          submenu: (_current, done) => actionSubmenu(
            context,
            'Host settings',
            'Open Host settings',
            'Browse plugin namespaces without leaving this settings session',
            'host',
            done,
          ),
        },
        {
          id: '__save__',
          label: 'Save and apply',
          description: 'Write the staged fields as one revision-guarded profile mutation.',
          value: '',
          submenu: (_current, done) => actionSubmenu(
            context,
            'Save TUI settings',
            draft.size === 0 ? 'Nothing to save' : 'Save ' + pendingLabel(draft.size),
            draft.size === 0 ? 'Nothing to write' : 'Writes ' + pendingLabel(draft.size) + ' to the profile',
            'save',
            done,
          ),
        },
        {
          id: '__discard__',
          label: 'Discard changes',
          description: 'Drop every staged edit and reload values from the profile.',
          value: '',
          submenu: (_current, done) => actionSubmenu(
            context,
            'Discard changes',
            draft.size === 0 ? 'Nothing to discard' : 'Discard ' + pendingLabel(draft.size),
            'Drop the staged edits and keep the saved profile',
            'discard',
            done,
          ),
        },
        {
          id: '__close__',
          label: 'Close',
          description: 'Leave settings. Unsaved edits are dropped after confirmation.',
          value: '',
          submenu: (_current, done) => actionSubmenu(
            context,
            'Close settings',
            'Close',
            draft.size === 0 ? 'No pending changes' : 'Close without saving the staged edits',
            'close',
            done,
          ),
        },
      ],
      onChange: (id, value) => {
        const setting = TUI_SETTINGS.find(row => row.key === id)
        if (setting === undefined) return undefined
        return applyTuiSettingInput(draft, setting, baseline.get(setting.key), isOverridden(setting, descriptor), value)
      },
    }), ctx.signal)
    if (action === undefined) return
    if (action === 'host') {
      await openHostSettings(ctx, settings)
      continue
    }
    if (action === 'save') {
      if (draft.size === 0) {
        ctx.notice('info', 'No pending TUI settings changes.')
        continue
      }
      const changes = TUI_SETTINGS
        .filter(setting => draft.has(setting.key))
        .map(setting => ({ setting, staged: draft.get(setting.key)! }))
      const ops: SettingsPathOp[] = changes.map(change => change.staged.unset === true
        ? { op: 'unset', path: [change.setting.key] }
        : { op: 'set', path: [change.setting.key], value: change.staged.value })
      try {
        const fresh = await writeSettingsOps(settings, 'native-tui', ops, descriptor.revision)
        if (fresh === undefined) {
          ctx.notice('warning', 'native-tui settings disappeared while saving.')
          return
        }
        draft.clear()
        ctx.notice('info', settingsSaveReceipt(changes))
        // Close on success so the receipt and the applied values are visible
        // immediately; /settings reopens the page for another pass.
        return
      }
      catch (error) {
        ctx.notice('error', 'Could not save TUI settings: ' + errorMessage(error))
        continue
      }
    }
    if (action === 'discard') {
      if (draft.size > 0) ctx.notice('info', 'Discarded ' + pendingLabel(draft.size) + '.')
      draft.clear()
      continue
    }
    // 'close' or 'cancel': confirm only when edits are staged.
    if (draft.size === 0) return
    if (await confirmDiscard(ctx, draft.size)) return
  }
}

/** Appended reminder for fields that cannot take effect now. */
function restartHint(changes: readonly { setting: TuiSetting }[]): string {
  const restart = changes.filter(change => change.setting.apply === 'restart').map(change => change.setting.key)
  const next = changes.filter(change => change.setting.apply === 'next-launch').map(change => change.setting.key)
  const parts: string[] = []
  if (restart.length > 0) parts.push('Restart the TUI or run /reload for ' + restart.join(', ') + '.')
  if (next.length > 0) parts.push('Next launch for ' + next.join(', ') + '.')
  return parts.length === 0 ? '' : NL + parts.join(' ')
}
