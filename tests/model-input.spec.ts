import { describe, expect, it } from 'vitest'
import {
  locateModelInput,
  modelInputSummary,
  modelInputWrite,
  validateModelInput,
  type ModelInputTarget,
} from '../src/runtime/model-input.js'

describe('model input location', () => {
  it('finds an explicit model declaration owned by the profile patch', () => {
    const models = [{ id: 'alpha', input: ['image', 'text'] }]
    const located = locateModelInput(
      { gateway: { models } },
      'gateway',
      'alpha',
      { providers: { gateway: { models } } },
    )
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target).toMatchObject({
      route: 'gateway',
      model: 'alpha',
      storage: 'models',
      index: 0,
      userOwnsModelIndex: true,
      declared: ['text', 'image'],
    })
  })

  it('treats an empty or absent input as an inherited declaration', () => {
    const empty = locateModelInput(
      { gateway: { models: [{ id: 'alpha', input: [] }] } },
      'gateway',
      'alpha',
    )
    expect(empty.ok).toBe(true)
    if (!empty.ok) throw new Error('expected a target')
    expect(empty.target.declared).toBeUndefined()
    expect(modelInputSummary(empty.target.declared)).toBe('not declared (inherits route default)')

    const absent = locateModelInput(
      { gateway: { models: [{ id: 'alpha' }] } },
      'gateway',
      'alpha',
    )
    expect(absent.ok).toBe(true)
    if (!absent.ok) throw new Error('expected a target')
    expect(absent.target.declared).toBeUndefined()
  })

  it('does not claim an inherited models array can be edited by index', () => {
    const providers = { gateway: { models: [{ id: 'alpha', input: ['text'] }] } }
    const located = locateModelInput(providers, 'gateway', 'alpha', { providers: { gateway: {} } })
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target.userOwnsModelIndex).toBe(false)
  })

  it('finds catalog model overrides and defaults absent ones to an inherit', () => {
    const located = locateModelInput({
      anthropic: {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        modelOverrides: {
          'claude-x': { name: 'Custom name', input: ['text', 'image'] },
        },
      },
    }, 'anthropic', 'claude-x')
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target).toMatchObject({
      storage: 'override',
      declared: ['text', 'image'],
      userOwnsModelIndex: false,
    })

    const unconfigured = locateModelInput({ anthropic: {} }, 'anthropic', 'claude-y')
    expect(unconfigured.ok).toBe(true)
    if (!unconfigured.ok) throw new Error('expected a target')
    expect(unconfigured.target.storage).toBe('override')
    expect(unconfigured.target.declared).toBeUndefined()
  })

  it('refuses missing routes, unlisted models, and invalid declarations', () => {
    expect(locateModelInput({}, 'gateway', 'alpha')).toEqual({ ok: false, reason: 'provider-missing' })
    expect(locateModelInput({ gateway: {} }, 'gateway', 'alpha')).toMatchObject({
      ok: true,
      target: { storage: 'override', declared: undefined },
    })
    expect(locateModelInput({ gateway: { models: [{ id: 'beta' }] } }, 'gateway', 'alpha'))
      .toEqual({ ok: false, reason: 'model-not-listed' })
    expect(locateModelInput({ gateway: { models: [{ id: 'alpha', input: 'text' }] } }, 'gateway', 'alpha'))
      .toEqual({ ok: false, reason: 'invalid-input' })
    expect(locateModelInput({ gateway: { models: [{ id: 'alpha', input: ['audio'] }] } }, 'gateway', 'alpha'))
      .toEqual({ ok: false, reason: 'invalid-input' })
    expect(locateModelInput({ anthropic: { modelOverrides: { 'claude-x': [] } } }, 'anthropic', 'claude-x'))
      .toEqual({ ok: false, reason: 'invalid-input' })
  })
})

describe('model input writes', () => {
  function target(overrides: Partial<ModelInputTarget>): ModelInputTarget {
    return {
      route: 'gateway',
      model: 'alpha',
      storage: 'models',
      declared: undefined,
      profile: {},
      index: 0,
      userOwnsModelIndex: true,
      ...overrides,
    }
  }

  it('writes a leaf for a model entry the profile patch owns', () => {
    expect(modelInputWrite(target({}), ['text'])).toEqual({
      op: 'set',
      path: ['providers', 'gateway', 'models', '0', 'input'],
      value: ['text'],
    })
    expect(modelInputWrite(target({ declared: ['text'] }), undefined)).toEqual({
      op: 'unset',
      path: ['providers', 'gateway', 'models', '0', 'input'],
    })
  })

  it('restates an inherited models array around one entry', () => {
    const profile = { models: [{ id: 'beta', input: ['text'] }, { id: 'alpha', input: ['text', 'image'] }] }
    const op = modelInputWrite(target({ profile, index: 1, userOwnsModelIndex: false, declared: ['text', 'image'] }), ['text'])
    expect(op).toEqual({
      op: 'set',
      path: ['providers', 'gateway', 'models'],
      value: [{ id: 'beta', input: ['text'] }, { id: 'alpha', input: ['text'] }],
    })
    const inherit = modelInputWrite(target({ profile, index: 1, userOwnsModelIndex: false, declared: ['text', 'image'] }), undefined)
    expect(inherit).toEqual({
      op: 'set',
      path: ['providers', 'gateway', 'models'],
      value: [{ id: 'beta', input: ['text'] }, { id: 'alpha' }],
    })
  })

  it('writes a catalog override leaf and can remove it again', () => {
    const override = target({ storage: 'override', index: undefined, declared: ['text'] })
    expect(modelInputWrite(override, ['text', 'image'])).toEqual({
      op: 'set',
      path: ['providers', 'gateway', 'modelOverrides', 'alpha', 'input'],
      value: ['text', 'image'],
    })
    expect(modelInputWrite(override, undefined)).toEqual({
      op: 'unset',
      path: ['providers', 'gateway', 'modelOverrides', 'alpha', 'input'],
    })
  })

  it('validates and canonicalizes modality lists', () => {
    expect(validateModelInput(['image', 'text'])).toEqual(['text', 'image'])
    expect(validateModelInput(['text'])).toEqual(['text'])
    expect(() => validateModelInput([])).toThrow('text and/or image')
    expect(() => validateModelInput(['audio'])).toThrow('only text and image')
    expect(() => validateModelInput(['text', 'text'])).toThrow('repeat')
  })

  it('summarizes declarations for menus and notices', () => {
    expect(modelInputSummary(undefined)).toBe('not declared (inherits route default)')
    expect(modelInputSummary(['text'])).toBe('text only')
    expect(modelInputSummary(['text', 'image'])).toBe('text + image')
  })
})
