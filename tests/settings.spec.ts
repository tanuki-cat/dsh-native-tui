import { describe, expect, it } from 'vitest'
import {
  settingsChildFields,
  settingsFields,
  settingsSetAt,
  settingsValueAt,
} from '../src/runtime/settings.js'

describe('settingsFields', () => {
  it('reads top-level dict keys from a schema envelope', () => {
    expect(settingsFields({ dict: { count: { type: 'number' }, mode: { type: 'string' } } })).toEqual(['count', 'mode'])
  })

  it('resolves the schemastery uid/refs envelope', () => {
    expect(settingsFields({
      uid: 3141,
      refs: { 3141: { type: 'object', dict: { count: {}, mode: {} } } },
    })).toEqual(['count', 'mode'])
  })

  it('returns no fields for non-object or empty schemas', () => {
    expect(settingsFields(undefined)).toEqual([])
    expect(settingsFields(null)).toEqual([])
    expect(settingsFields({ type: 'object' })).toEqual([])
    expect(settingsFields({ dict: [] })).toEqual([])
  })
})

describe('settingsChildFields', () => {
  it('resolves a nested uid/refs object', () => {
    const schema = {
      uid: 1,
      refs: {
        1: { type: 'object', dict: { nested: 2, leaf: 3 } },
        2: { type: 'object', dict: { live: 3, deeper: 4 } },
        3: { type: 'number' },
        4: { type: 'object', dict: { value: 3 } },
      },
    }
    expect(settingsChildFields(schema, ['nested'])).toEqual(['live', 'deeper'])
    expect(settingsChildFields(schema, ['nested', 'deeper'])).toEqual(['value'])
    expect(settingsChildFields(schema, ['missing'])).toEqual([])
    expect(settingsChildFields(schema, ['leaf'])).toEqual([])
  })
})

describe('settingsValueAt / settingsSetAt', () => {
  it('reads and writes nested object paths', () => {
    const root = { nested: { live: 3 } }
    expect(settingsValueAt(root, ['nested', 'live'])).toBe(3)
    expect(settingsValueAt(root, ['nested', 'missing'])).toBeUndefined()
    settingsSetAt(root, ['nested', 'live'], 4)
    expect(root.nested.live).toBe(4)
    settingsSetAt(root, ['nested', 'created', 'value'], 5)
    expect(root).toEqual({ nested: { live: 4, created: { value: 5 } } })
    expect(() => settingsSetAt(root, [], 1)).toThrow('settings path must not be empty')
  })
})
