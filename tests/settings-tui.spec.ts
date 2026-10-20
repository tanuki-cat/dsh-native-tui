import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'
import type { SettingsDescriptor } from '../src/ui/commands/settings-common.js'
import {
  TUI_SETTINGS,
  applyTuiSettingInput,
  settingsSaveReceipt,
  type TuiSetting,
  type TuiStagedValue,
} from '../src/ui/commands/settings-tui.js'
import { SETTINGS_RESET } from '../src/ui/settings-panel.js'

/** The effective descriptor shape the page reads. */
function descriptorOf(value: Record<string, unknown>, user?: Record<string, unknown>): SettingsDescriptor {
  return {
    ns: 'native-tui',
    schema: {},
    value,
    ...(user === undefined ? {} : { user }),
    revision: 1,
    applies: 'live',
    autoGenerate: true,
  }
}

/** One known terminal setting. */
function settingOf(key: string): TuiSetting {
  const setting = TUI_SETTINGS.find(row => row.key === key)
  if (setting === undefined) throw new Error('missing setting ' + key)
  return setting
}

describe('TUI_SETTINGS coverage', () => {
  it('lists every declared terminal config key exactly once', () => {
    const json = Config.toJSON() as {
      uid?: number
      refs?: Record<string, { dict?: Record<string, unknown> }>
      dict?: Record<string, unknown>
    }
    const root = json.dict ?? (json.uid === undefined ? undefined : json.refs?.[String(json.uid)])
    expect(root?.dict).toBeTypeOf('object')
    const declared = Object.keys(root?.dict ?? {})
    expect(TUI_SETTINGS.map(setting => setting.key).sort()).toEqual(declared.sort())
    expect(new Set(TUI_SETTINGS.map(setting => setting.key)).size).toBe(TUI_SETTINGS.length)
  })

  it('makes every declared field live-editable and described in the schema', () => {
    const json = Config.toJSON() as {
      uid?: number
      refs?: Record<string, {
        dict?: Record<string, number | string>
        meta?: { volatile?: boolean; description?: string }
      }>
    }
    const root = json.uid === undefined ? undefined : json.refs?.[String(json.uid)]
    for (const [key, ref] of Object.entries(root?.dict ?? {})) {
      const node = typeof ref === 'number' || typeof ref === 'string' ? json.refs?.[String(ref)] : ref
      expect(node?.meta?.volatile, key + ' is volatile').toBe(true)
      expect(node?.meta?.description?.length, key + ' has a description').toBeGreaterThan(10)
    }
  })

  it('keeps labels, sections, and apply modes readable', () => {
    for (const setting of TUI_SETTINGS) {
      expect(setting.label.length).toBeGreaterThan(0)
      expect(setting.description.length).toBeGreaterThan(10)
      expect(['Display', 'Terminal', 'Session']).toContain(setting.section)
      expect(['live', 'restart', 'next-launch']).toContain(setting.apply)
    }
  })
})

describe('terminal setting defaults', () => {
  const config = resolveConfig(undefined)

  it('derives thinking display from the legacy switch while unset', () => {
    expect(settingOf('thinkingDisplay').fallback(descriptorOf({ showReasoning: false }), config)).toBe('hidden')
    expect(settingOf('thinkingDisplay').fallback(descriptorOf({ showReasoning: true }), config)).toBe('detailed')
  })

  it('falls back to runtime defaults for absent profile values', () => {
    const empty = descriptorOf({})
    expect(settingOf('runCodeDisplay').fallback(empty, config)).toBe('detailed')
    expect(settingOf('maxTranscriptEntries').fallback(empty, config)).toBe(2000)
    expect(settingOf('theme').fallback(empty, config)).toBe('auto')
    expect(settingOf('fullscreen').fallback(empty, config)).toBe(false)
    expect(settingOf('title').fallback(empty, config)).toBe('DeepSeek Harness')
    expect(settingOf('showReasoning').fallback(empty, config)).toBe(true)
    expect(settingOf('cwd').fallback(empty, config)).toBe(process.cwd())
    expect(settingOf('sessionId').fallback(empty, config)).toBeUndefined()
    expect(settingOf('agentPreset').fallback(empty, config)).toBeUndefined()
  })
})

describe('applyTuiSettingInput', () => {
  it('stages a changed choice and returns its display text', () => {
    const draft = new Map<string, TuiStagedValue>()
    const setting = settingOf('thinkingDisplay')
    expect(applyTuiSettingInput(draft, setting, 'detailed', false, 'compact')).toBe('compact')
    expect(draft.get(setting.key)).toEqual({ value: 'compact' })
  })

  it('drops a staged value that matches the effective default with no override', () => {
    const draft = new Map<string, TuiStagedValue>()
    const setting = settingOf('thinkingDisplay')
    draft.set(setting.key, { value: 'compact' })
    expect(applyTuiSettingInput(draft, setting, 'detailed', false, 'detailed')).toBe('detailed')
    expect(draft.has(setting.key)).toBe(false)
  })

  it('removes the override on reset and falls back to the effective value', () => {
    const draft = new Map<string, TuiStagedValue>()
    const setting = settingOf('theme')
    draft.set(setting.key, { value: 'dark' })
    expect(applyTuiSettingInput(draft, setting, 'auto', true, SETTINGS_RESET)).toBe('auto')
    expect(draft.get(setting.key)).toEqual({ unset: true })
  })

  it('treats reset without an existing override as a no-op', () => {
    const draft = new Map<string, TuiStagedValue>()
    const setting = settingOf('theme')
    draft.set(setting.key, { value: 'dark' })
    expect(applyTuiSettingInput(draft, setting, 'auto', false, SETTINGS_RESET)).toBe('auto')
    expect(draft.has(setting.key)).toBe(false)
  })

  it('treats empty text and number input as reset', () => {
    const draft = new Map<string, TuiStagedValue>()
    const title = settingOf('title')
    draft.set(title.key, { value: 'Work' })
    expect(applyTuiSettingInput(draft, title, 'DeepSeek Harness', true, '')).toBe('DeepSeek Harness')
    expect(draft.get(title.key)).toEqual({ unset: true })

    const entries = settingOf('maxTranscriptEntries')
    const numberDraft = new Map<string, TuiStagedValue>()
    numberDraft.set(entries.key, { value: 500 })
    expect(applyTuiSettingInput(numberDraft, entries, 2000, true, '')).toBe('2000')
    expect(numberDraft.get(entries.key)).toEqual({ unset: true })
  })

  it('parses booleans and numbers into typed staged values', () => {
    const draft = new Map<string, TuiStagedValue>()
    expect(applyTuiSettingInput(draft, settingOf('fullscreen'), false, false, 'on')).toBe('on')
    expect(draft.get('fullscreen')).toEqual({ value: true })
    expect(applyTuiSettingInput(draft, settingOf('maxTranscriptEntries'), 2000, false, '500')).toBe('500')
    expect(draft.get('maxTranscriptEntries')).toEqual({ value: 500 })
  })

  it('keeps a text value that differs from the fallback', () => {
    const draft = new Map<string, TuiStagedValue>()
    const title = settingOf('title')
    expect(applyTuiSettingInput(draft, title, 'DeepSeek Harness', false, 'Work')).toBe('Work')
    expect(draft.get(title.key)).toEqual({ value: 'Work' })
  })
})

describe('settingsSaveReceipt', () => {
  it('groups live, restart, and next-launch fields', () => {
    const receipt = settingsSaveReceipt([
      { setting: settingOf('title'), staged: { value: 'Work' } },
      { setting: settingOf('theme'), staged: { value: 'dark' } },
      { setting: settingOf('cwd'), staged: { value: '/tmp' } },
    ])
    expect(receipt).toContain('title (live)')
    expect(receipt).toContain('theme (restart)')
    expect(receipt).toContain('cwd (next launch)')
    expect(receipt).toContain('Restart the TUI or run /reload for theme.')
    expect(receipt).toContain('Next launch for cwd.')
  })

  it('adds no reminder for live-only changes', () => {
    const receipt = settingsSaveReceipt([{ setting: settingOf('title'), staged: { value: 'Work' } }])
    expect(receipt).toBe('Saved TUI settings: title (live).')
  })
})
