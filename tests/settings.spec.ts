import { describe, expect, it } from 'vitest'
import {
  settingsChildFields,
  settingsFieldAt,
  settingsFields,
  settingsFormatValue,
  settingsFormChildren,
  settingsFormFields,
  settingsIsSecretPath,
  settingsParseInput,
  settingsPathLabel,
  settingsPathOps,
  settingsSetAt,
  settingsSpecOfNode,
  settingsValueAt,
  settingsValuesEqual,
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

describe('settingsFormFields', () => {
  const schema = {
    uid: 1,
    refs: {
      1: {
        type: 'object',
        dict: { mode: 2, count: 4, nested: 6, models: 8, name: 10, flags: 11 },
      },
      2: { type: 'union', meta: { description: 'pick one', volatile: true }, list: [3, 5] },
      3: { type: 'const', value: 'a' },
      5: { type: 'const', value: 'b' },
      4: { type: 'number', meta: { min: 50, max: 9000, step: 1, default: 2000 } },
      6: { type: 'object', meta: { description: 'nested help' }, dict: { live: 4 } },
      8: { type: 'array', inner: 6 },
      10: { type: 'string', meta: { role: 'secret' } },
      11: { type: 'object' },
    },
  }

  it('projects declared fields with types, options, bounds, and metadata', () => {
    const fields = settingsFormFields(schema)
    expect(fields.map(field => field.name)).toEqual(['mode', 'count', 'nested', 'models', 'name', 'flags'])

    const mode = fields[0]
    expect(mode?.type).toBe('union')
    expect(mode?.options).toEqual(['a', 'b'])
    expect(mode?.description).toBe('pick one')
    expect(mode?.required).toBe(false)

    const count = fields[1]
    expect(count?.type).toBe('number')
    expect(count?.min).toBe(50)
    expect(count?.max).toBe(9000)
    expect(count?.step).toBe(1)
    expect(count?.defaultValue).toBe(2000)

    const nested = fields[2]
    expect(nested?.type).toBe('object')
    expect(nested?.description).toBe('nested help')
    expect(nested?.children?.map(child => child.name)).toEqual(['live'])

    const models = fields[3]
    expect(models?.type).toBe('array')
    expect(models?.item?.type).toBe('object')
    expect(models?.item?.children?.map(child => child.name)).toEqual(['live'])

    expect(fields[4]?.secret).toBe(true)
    expect(fields[5]?.dynamic).toBe(true)
  })

  it('finds a nested schema node and its declared children', () => {
    expect(settingsFieldAt(schema, ['nested'])).toMatchObject({ type: 'object' })
    expect(settingsFieldAt(schema, ['missing'])).toBeUndefined()
    expect(settingsFormChildren(schema, ['nested']).map(child => child.name)).toEqual(['live'])
    expect(settingsFormChildren(schema, ['missing'])).toEqual([])
  })

  it('builds an item spec for undeclared values', () => {
    const spec = settingsSpecOfNode(schema, { type: 'string' }, 'entry')
    expect(spec.name).toBe('entry')
    expect(spec.type).toBe('string')
  })
})

describe('settingsParseInput', () => {
  const field = (type: string, extra: Record<string, unknown> = {}) => ({
    name: 'x',
    type: type as never,
    required: false,
    secret: false,
    dynamic: false,
    raw: {},
    ...extra,
  })

  it('parses strings without trimming the stored value', () => {
    expect(settingsParseInput(field('string'), '  hello  ')).toEqual({ ok: true, value: '  hello  ' })
  })

  it('validates numbers against step and bounds', () => {
    const spec = field('number', { step: 1, min: 50, max: 100 })
    expect(settingsParseInput(spec, '75')).toEqual({ ok: true, value: 75 })
    expect(settingsParseInput(spec, '7.5')).toMatchObject({ ok: false })
    expect(settingsParseInput(spec, '49')).toMatchObject({ ok: false })
    expect(settingsParseInput(spec, '101')).toMatchObject({ ok: false })
    expect(settingsParseInput(spec, 'nope')).toMatchObject({ ok: false })
  })

  it('parses booleans in the terminal vocabulary', () => {
    const spec = field('boolean')
    expect(settingsParseInput(spec, 'on')).toEqual({ ok: true, value: true })
    expect(settingsParseInput(spec, 'false')).toEqual({ ok: true, value: false })
    expect(settingsParseInput(spec, 'maybe')).toMatchObject({ ok: false })
  })

  it('matches declared options for const and union nodes', () => {
    const spec = field('union', { options: ['hidden', 'compact', 'detailed'] })
    expect(settingsParseInput(spec, 'compact')).toEqual({ ok: true, value: 'compact' })
    expect(settingsParseInput(spec, 'loud')).toMatchObject({ ok: false })
  })

  it('parses JSON for arrays, objects, and unions without literal options', () => {
    expect(settingsParseInput(field('array'), '["a", 1]')).toEqual({ ok: true, value: ['a', 1] })
    expect(settingsParseInput(field('object'), '{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(settingsParseInput(field('union'), '{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(settingsParseInput(field('array'), '{"a":1}')).toMatchObject({ ok: false })
    expect(settingsParseInput(field('object'), '[]')).toMatchObject({ ok: false })
    expect(settingsParseInput(field('array'), '[not json')).toMatchObject({ ok: false })
  })
})

describe('settings display and path helpers', () => {
  it('formats values on one line', () => {
    expect(settingsFormatValue(undefined)).toBe('(unset)')
    expect(settingsFormatValue('')).toBe('(empty)')
    expect(settingsFormatValue('a\nb')).toBe('a b')
    expect(settingsFormatValue({ a: 1 })).toBe('{"a":1}')
    expect(settingsFormatValue('abcdefgh', 5)).toBe('abcd…')
  })

  it('labels object and array paths', () => {
    expect(settingsPathLabel(['models', '0', 'id'])).toBe('models[0].id')
    expect(settingsPathLabel(['0'])).toBe('[0]')
    expect(settingsPathLabel(['a', 'b'])).toBe('a.b')
  })

  it('detects secret slots and their descendants, not ancestors', () => {
    const secrets = [{ path: ['providers', 'demo', 'apiKey'] }]
    expect(settingsIsSecretPath(secrets, ['providers', 'demo', 'apiKey'])).toBe(true)
    expect(settingsIsSecretPath(secrets, ['providers', 'demo', 'apiKey', 'value'])).toBe(true)
    expect(settingsIsSecretPath(secrets, ['providers', 'demo'])).toBe(false)
    expect(settingsIsSecretPath(undefined, ['providers'])).toBe(false)
  })

  it('compares JSON-shaped values for staged change tracking', () => {
    expect(settingsValuesEqual('a', 'a')).toBe(true)
    expect(settingsValuesEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
    expect(settingsValuesEqual([1], [2])).toBe(false)
    expect(settingsValuesEqual(null, {})).toBe(false)
  })

  it('turns staged changes into path operations', () => {
    expect(settingsPathOps([
      { path: ['mode'], value: 'compact' },
      { path: ['models', '0', 'id'], unset: true },
    ])).toEqual([
      { op: 'set', path: ['mode'], value: 'compact' },
      { op: 'unset', path: ['models', '0', 'id'] },
    ])
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
