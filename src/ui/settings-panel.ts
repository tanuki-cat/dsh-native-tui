/**
 * One full-screen settings surface: pi-tui's `SettingsList` inside the shared
 * opaque dialog frame.
 *
 * The list owns search, keyboard navigation, value cycling, and submenus. This
 * wrapper adds the product-level chrome (a title that tracks staged edits, a
 * hint row) and resolves one action when the user leaves the surface. The
 * command layer owns what a value means and when it is persisted, so the same
 * wrapper serves the native terminal page and the Host namespace browser.
 *
 * @module dsh-native-tui/ui/settings-panel
 */

import {
  Input,
  SelectList,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
  type SettingsListTheme,
  type TUI,
} from '@earendil-works/pi-tui'
import type { ChoiceItem } from './dialogs.js'
import { dialogFrame } from './dialogs.js'
import { selectTheme, type Palette } from './theme.js'

/** Sentinel a field submenu returns to remove the saved override. */
export const SETTINGS_RESET = '\u0000reset'

/** How the user left one settings surface. */
export type SettingsPanelAction = 'save' | 'discard' | 'host' | 'close' | 'cancel'

/** One row the settings panel renders. */
export interface SettingsPanelItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** Current value text. */
  readonly value: string
  /** Cycle these values with Enter/Space. */
  readonly values?: readonly string[]
  /** Open this component when the row is activated. */
  readonly submenu?: SettingItem['submenu']
}

/** What the panel needs from its owner. */
export interface SettingsPanelSpec {
  /** Header text; called on every frame so it can report staged edits. */
  readonly title: () => string
  /** Hint row below the list. */
  readonly hint: string
  readonly items: readonly SettingsPanelItem[]
  /**
   * Apply one list change to the staged state.
   * @returns replacement value text, or undefined to keep what SettingsList set.
   */
  readonly onChange: (id: string, value: string) => string | undefined
}

/** Helpers the owner uses while building submenus. */
export interface SettingsPanelContext {
  /** Leave the surface with one action. */
  readonly finish: (action: SettingsPanelAction) => void
  /** Repaint after changing the title or item values. */
  readonly refresh: () => void
  readonly palette: Palette
}

function panelTheme(palette: Palette): SettingsListTheme {
  return {
    label: (text, selected) => selected ? palette.bold(palette.accent(text)) : text,
    value: (text, selected) => selected ? palette.bold(palette.accent(text)) : palette.dim(text),
    description: text => palette.dim(text),
    cursor: palette.accent('▸ '),
    hint: text => palette.dim(text),
  }
}

/** Component that frames a SettingsList and keeps its chrome in sync. */
class SettingsPanel implements Component {
  private readonly list: SettingsList
  constructor(
    private readonly spec: SettingsPanelSpec,
    private readonly palette: Palette,
    private readonly onChange: (id: string, value: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.list = new SettingsList(
      spec.items.map(item => ({
        id: item.id,
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
        currentValue: item.value,
        ...(item.values === undefined ? {} : { values: [...item.values] }),
        ...(item.submenu === undefined ? {} : { submenu: item.submenu }),
      })),
      Math.min(11, Math.max(3, spec.items.length)),
      panelTheme(palette),
      (id, value) => { onChange(id, value) },
      onCancel,
      { enableSearch: true },
    )
  }

  /** Replace one row's value after an owner-side normalization. */
  updateValue(id: string, value: string): void {
    this.list.updateValue(id, value)
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4)
    return dialogFrame([
      ...new Text(this.spec.title(), 0, 0).render(inner),
      '',
      ...this.list.render(inner),
      '',
      ...new Text(this.palette.dim(this.spec.hint), 0, 0).render(inner),
    ], width, this.palette)
  }

  handleInput(data: string): void { this.list.handleInput(data) }
  invalidate(): void { this.list.invalidate() }
}

/**
 * Show one settings surface until the user leaves it.
 * @param tui - terminal overlay surface.
 * @param palette - palette the panel renders with.
 * @param build - builds the title/items/hint; receives finish and refresh.
 * @param signal - command cancellation.
 * @returns the action, or undefined when cancelled/aborted.
 */
export function showSettingsPanel(
  tui: TUI,
  palette: Palette,
  build: (context: SettingsPanelContext) => SettingsPanelSpec,
  signal?: AbortSignal,
): Promise<SettingsPanelAction | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve(undefined)
      return
    }
    let settled = false
    let handle: ReturnType<TUI['showOverlay']> | undefined
    let panel: SettingsPanel | undefined
    const finish = (action: SettingsPanelAction | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      handle?.hide()
      resolve(action)
    }
    const onAbort = (): void => { finish(undefined) }
    try {
      const spec = build({
        finish: action => { finish(action) },
        refresh: () => { tui.requestRender() },
        palette,
      })
      panel = new SettingsPanel(
        spec,
        palette,
        (id, value) => {
          const next = spec.onChange(id, value)
          if (next !== undefined) panel?.updateValue(id, next)
          tui.requestRender()
        },
        () => { finish('cancel') },
      )
      handle = tui.showOverlay(panel, { width: 88, maxHeight: '90%', anchor: 'center' })
      handle.focus()
    }
    catch (error) {
      reject(error)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Component that owns a submenu SelectList and its chrome. */
class ChoiceSubmenu implements Component {
  private readonly list: SelectList
  constructor(
    private readonly title: string,
    items: readonly ChoiceItem[],
    private readonly hint: string,
    private readonly palette: Palette,
    onSelect: (value: string) => void,
    onCancel: () => void,
    selected?: string,
  ) {
    this.list = new SelectList(
      items.map(item => ({
        value: item.value,
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
      })),
      Math.min(10, Math.max(1, items.length)),
      selectTheme(palette),
    )
    if (selected !== undefined) {
      const index = items.findIndex(item => item.label === selected || item.value === selected)
      if (index >= 0) this.list.setSelectedIndex(index)
    }
    this.list.onSelect = item => { onSelect(item.value) }
    this.list.onCancel = () => { onCancel() }
  }

  render(width: number): string[] {
    return [
      ...new Text(this.palette.bold(this.title), 0, 0).render(width),
      '',
      ...this.list.render(width),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(width),
    ]
  }

  handleInput(data: string): void { this.list.handleInput(data) }
  invalidate(): void { this.list.invalidate() }
}

/** Render a titled select list as a SettingsList submenu. */
export function settingsChoiceSubmenu(
  palette: Palette,
  title: string,
  items: readonly ChoiceItem[],
  onSelect: (value: string) => void,
  onCancel: () => void,
  hint = 'Enter selects · Esc back',
  selected?: string,
): Component {
  return new ChoiceSubmenu(title, items, hint, palette, onSelect, onCancel, selected)
}

/** Component that validates one text value and reports the error inline. */
class InputSubmenu implements Component {
  private readonly input: Input
  private error = ''
  constructor(
    private readonly title: string,
    private readonly hint: string,
    private readonly palette: Palette,
    placeholder: string,
    initialValue: string | undefined,
    private readonly validate: (value: string) => string | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
  ) {
    this.input = new Input({ prompt: '> ', placeholder })
    if (initialValue !== undefined) {
      this.input.setValue(initialValue)
      // setValue places the cursor before the text; a prefilled field should
      // open at its end so typing extends the value.
      this.input.handleInput('\x05')
    }
    this.input.focused = true
    this.input.onSubmit = (raw) => {
      const value = raw.trim()
      const error = this.validate(value)
      if (error !== undefined) {
        this.error = error
        return
      }
      onSubmit(value)
    }
    this.input.onEscape = () => { onCancel() }
  }

  render(width: number): string[] {
    return [
      ...new Text(this.palette.bold(this.title), 0, 0).render(width),
      '',
      ...this.input.render(width),
      ...(this.error === '' ? [] : ['', ...new Text(this.palette.error(this.error), 0, 0).render(width)]),
      '',
      ...new Text(this.palette.dim(this.hint), 0, 0).render(width),
    ]
  }

  handleInput(data: string): void { this.input.handleInput(data) }
  invalidate(): void { this.input.invalidate() }
}

/**
 * Render a titled text input as a SettingsList submenu.
 * @param options - current value, placeholder, hint, and validation.
 * @returns the submenu component.
 */
export function settingsInputSubmenu(options: {
  readonly palette: Palette
  readonly title: string
  readonly placeholder: string
  readonly hint: string
  readonly initialValue?: string
  readonly validate?: (value: string) => string | undefined
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}): Component {
  return new InputSubmenu(
    options.title,
    options.hint,
    options.palette,
    options.placeholder,
    options.initialValue,
    options.validate ?? (() => undefined),
    options.onSubmit,
    options.onCancel,
  )
}
