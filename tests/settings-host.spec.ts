import { describe, expect, it } from 'vitest'
import { enumerateHostFields } from '../src/ui/commands/settings-host.js'
import type { SettingsDescriptor } from '../src/ui/commands/settings-common.js'

const schema = {
  uid: 1,
  refs: {
    1: {
      type: 'object',
      dict: { name: 2, flags: 3, models: 5, route: 9, secret: 12 },
    },
    2: { type: 'string' },
    3: { type: 'object', dict: { verbose: 4 } },
    4: { type: 'boolean' },
    5: { type: 'array', inner: 6 },
    6: { type: 'object', dict: { id: 2, key: 12, nested: 7 } },
    7: { type: 'array', inner: 2 },
    9: { type: 'dict', inner: 2 },
    12: { type: 'string', meta: { role: 'secret' } },
  },
}

function descriptorOf(overrides: Partial<SettingsDescriptor> = {}): SettingsDescriptor {
  return {
    ns: 'demo',
    schema,
    value: {
      name: 'demo',
      flags: { verbose: true },
      models: [
        { id: 'm1', key: 'secret-value', nested: ['a'] },
        { id: 'm2' },
      ],
      route: { alpha: 'one' },
    },
    user: { name: 'profile-name', flags: { verbose: true } },
    secrets: [
      { path: ['models', '0', 'key'], set: true },
      { path: ['secret'], set: false },
    ],
    revision: 3,
    applies: 'live',
    autoGenerate: true,
    ...overrides,
  }
}

describe('enumerateHostFields', () => {
  it('lists scalar leaves, nested objects, arrays, and dynamic records', () => {
    const fields = enumerateHostFields(descriptorOf())
    const labels = fields.map(field => field.path.join('.'))
    expect(labels).toContain('name')
    expect(labels).toContain('flags.verbose')
    expect(labels).toContain('models')
    expect(labels).toContain('models.0')
    expect(labels).toContain('models.0.id')
    expect(labels).toContain('models.1.id')
    expect(labels).toContain('models.0.nested')
    expect(labels).toContain('models.0.nested.0')
    expect(labels).toContain('route')
    expect(labels).toContain('route.alpha')
    expect(labels).toContain('secret')
  })

  it('marks arrays, array items, overrides, and secrets', () => {
    const fields = enumerateHostFields(descriptorOf())
    const byPath = (path: string) => fields.find(field => field.path.join('.') === path)

    expect(byPath('models')?.array).toBe(true)
    expect(byPath('models')?.containsSecret).toBe(true)
    expect(byPath('models.0')?.arrayItem).toBe(true)
    expect(byPath('models.0')?.containsSecret).toBe(true)
    expect(byPath('models.0.key')?.secret).toBe(true)
    expect(byPath('models.0.id')?.secret).toBe(false)
    expect(byPath('name')?.overridden).toBe(true)
    expect(byPath('flags.verbose')?.overridden).toBe(true)
    expect(byPath('models.1.id')?.overridden).toBe(false)
    expect(byPath('secret')?.secret).toBe(true)
    expect(byPath('route')?.type).toBe('dict')
    expect(byPath('route')?.containsSecret).toBe(false)
  })

  it('locks index edits below an array the profile does not override', () => {
    const fields = enumerateHostFields(descriptorOf())
    const byPath = (path: string) => fields.find(field => field.path.join('.') === path)
    expect(byPath('models')?.overridden).toBe(false)
    expect(byPath('models')?.arrayLocked).toBe(false)
    expect(byPath('models.0')?.arrayLocked).toBe(true)
    expect(byPath('models.0.id')?.arrayLocked).toBe(true)

    const overridden = enumerateHostFields(descriptorOf({
      user: { models: [{ id: 'm1' }] },
    }))
    const modelItem = overridden.find(field => field.path.join('.') === 'models.0')
    expect(modelItem?.arrayLocked).toBe(false)
  })

  it('shows declared object children even when the value is absent', () => {
    const fields = enumerateHostFields(descriptorOf({ value: { models: [] } }))
    expect(fields.map(field => field.path.join('.'))).toContain('flags.verbose')
    expect(fields.find(field => field.path.join('.') === 'flags.verbose')?.value).toBeUndefined()
  })

  it('keeps an array row when the profile value is not an array', () => {
    const fields = enumerateHostFields(descriptorOf({ value: { models: 'broken' } }))
    const models = fields.find(field => field.path.join('.') === 'models')
    expect(models?.array).toBe(true)
    expect(fields.some(field => field.path.join('.') === 'models.0')).toBe(false)
  })
})
