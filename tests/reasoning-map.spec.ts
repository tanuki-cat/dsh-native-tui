import { describe, expect, it } from 'vitest'
import {
  locateReasoningMap,
  reasoningMapSummary,
  reasoningMapWrite,
  reasoningWireLabel,
  sameNameReasoningEfforts,
  withReasoningLevel,
  withoutReasoningLevel,
  type ReasoningMapTarget,
} from '../src/runtime/reasoning-map.js'

describe('reasoning map location', () => {
  it('finds an explicit model map owned by the profile patch', () => {
    const models = [{ id: 'alpha', reasoningEfforts: { off: null, low: 'low', high: 'HIGH' } }]
    const located = locateReasoningMap(
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
      disabled: false,
      efforts: { off: null, low: 'low', high: 'HIGH' },
    })
  })

  it('does not claim an inherited models array can be edited by index', () => {
    const providers = { gateway: { models: [{ id: 'alpha', reasoningEfforts: { low: 'low' } }] } }
    const located = locateReasoningMap(providers, 'gateway', 'alpha', { providers: { gateway: {} } })
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target.userOwnsModelIndex).toBe(false)
  })

  it('reads an explicitly disabled model as an empty map', () => {
    const located = locateReasoningMap(
      { gateway: { models: [{ id: 'alpha', reasoningEfforts: false }] } },
      'gateway',
      'alpha',
    )
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target.disabled).toBe(true)
    expect(located.target.efforts).toEqual({})
  })

  it('finds catalog model overrides and defaults absent ones to an empty map', () => {
    const located = locateReasoningMap({
      anthropic: {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        modelOverrides: {
          'claude-x': { name: 'Custom name', reasoningEfforts: { low: 'LOW' } },
        },
      },
    }, 'anthropic', 'claude-x')
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target).toMatchObject({
      storage: 'override',
      disabled: false,
      efforts: { low: 'LOW' },
    })

    const unconfigured = locateReasoningMap({ anthropic: {} }, 'anthropic', 'claude-y')
    expect(unconfigured.ok).toBe(true)
    if (!unconfigured.ok) throw new Error('expected a target')
    expect(unconfigured.target.storage).toBe('override')
    expect(unconfigured.target.efforts).toEqual({})
  })

  it('treats an empty models list as a catalog route, not a closed list', () => {
    // `models: []` (the openai-codex route) selects the adapter's native
    // catalogue; the map then lives in modelOverrides.
    const located = locateReasoningMap({
      'openai-codex': {
        models: [],
        modelOverrides: { 'gpt-6-sol': { reasoningEfforts: { high: 'high', max: 'max' } } },
      },
    }, 'openai-codex', 'gpt-6-sol')
    expect(located.ok).toBe(true)
    if (!located.ok) throw new Error('expected a target')
    expect(located.target).toMatchObject({
      storage: 'override',
      efforts: { high: 'high', max: 'max' },
    })

    const unconfigured = locateReasoningMap({ 'openai-codex': { models: [] } }, 'openai-codex', 'gpt-6-sol')
    expect(unconfigured.ok).toBe(true)
    if (!unconfigured.ok) throw new Error('expected a target')
    expect(unconfigured.target.efforts).toEqual({})
  })

  it('refuses missing routes, unlisted models, and invalid maps', () => {
    expect(locateReasoningMap({}, 'gateway', 'alpha')).toEqual({ ok: false, reason: 'provider-missing' })
    // A non-empty list is explicit: a model outside it is not offered.
    expect(locateReasoningMap({ gateway: { models: [{ id: 'beta' }] } }, 'gateway', 'alpha'))
      .toEqual({ ok: false, reason: 'model-not-listed' })
    expect(locateReasoningMap({
      gateway: { models: [{ id: 'alpha', reasoningEfforts: { high: '' } }] },
    }, 'gateway', 'alpha')).toEqual({ ok: false, reason: 'invalid-map' })
    expect(locateReasoningMap({
      gateway: { models: [{ id: 'alpha', reasoningEfforts: { turbo: 'turbo' } }] },
    }, 'gateway', 'alpha')).toEqual({ ok: false, reason: 'invalid-map' })
    expect(locateReasoningMap({
      anthropic: { modelOverrides: { 'claude-x': { reasoningEfforts: { high: 2 } } } },
    }, 'anthropic', 'claude-x')).toEqual({ ok: false, reason: 'invalid-map' })
  })
})

describe('reasoning map staging', () => {
  it('orders levels and removes one without mutating the input', () => {
    const before = { high: 'HIGH', low: 'low' }
    expect(withReasoningLevel(before, 'medium', 'MED')).toEqual({ low: 'low', medium: 'MED', high: 'HIGH' })
    expect(withoutReasoningLevel(before, 'high')).toEqual({ low: 'low' })
    expect(before).toEqual({ high: 'HIGH', low: 'low' })
  })

  it('renders wire labels and a level-ordered summary', () => {
    expect(reasoningWireLabel(null)).toBe('omit')
    expect(reasoningWireLabel('')).toBe('omit')
    expect(reasoningWireLabel('high')).toBe('high')
    expect(reasoningMapSummary({ high: 'HIGH', off: null, low: 'low' }))
      .toBe('off → omit, low → low, high → HIGH')
    expect(reasoningMapSummary({})).toBe('no levels')
  })

  it('returns a fresh same-name default map', () => {
    const first = sameNameReasoningEfforts()
    const second = sameNameReasoningEfforts()
    expect(first).toEqual({ low: 'low', medium: 'medium', high: 'high' })
    expect(first).not.toBe(second)
  })
})

describe('reasoning map writes', () => {
  function locate(providers: unknown, route: string, model: string, user?: unknown): ReasoningMapTarget {
    const found = locateReasoningMap(providers, route, model, user)
    if (!found.ok) throw new Error('expected a target')
    return found.target
  }

  it('writes a leaf path when the profile patch owns the models array', () => {
    const models = [{ id: 'alpha', reasoningEfforts: { low: 'low' } }]
    const target = locate({ gateway: { models } }, 'gateway', 'alpha', { providers: { gateway: { models } } })
    expect(reasoningMapWrite(target, { high: 'HIGH', low: 'low' })).toEqual({
      path: ['providers', 'gateway', 'models', '0', 'reasoningEfforts'],
      value: { low: 'low', high: 'HIGH' },
    })
  })

  it('restates a merged models array inherited from another layer', () => {
    const target = locate({
      gateway: {
        apiKeyEnv: 'GATEWAY_KEY',
        models: [
          { id: 'alpha', name: 'Alpha', reasoningEfforts: { low: 'low' } },
          { id: 'beta', name: 'Beta' },
        ],
      },
    }, 'gateway', 'alpha', { providers: { gateway: {} } })
    expect(reasoningMapWrite(target, { low: 'low', high: 'HIGH' })).toEqual({
      path: ['providers', 'gateway', 'models'],
      value: [
        { id: 'alpha', name: 'Alpha', reasoningEfforts: { low: 'low', high: 'HIGH' } },
        { id: 'beta', name: 'Beta' },
      ],
    })
  })

  it('writes only the reasoningEfforts leaf for a catalog override', () => {
    const target = locate({
      anthropic: {
        modelOverrides: { 'claude-x': { name: 'Custom', reasoningEfforts: { low: 'low' } } },
      },
    }, 'anthropic', 'claude-x')
    expect(reasoningMapWrite(target, { low: 'low', high: 'HIGH' })).toEqual({
      path: ['providers', 'anthropic', 'modelOverrides', 'claude-x', 'reasoningEfforts'],
      value: { low: 'low', high: 'HIGH' },
    })
  })
})
