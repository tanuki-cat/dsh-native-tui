import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, name } from '../src/codebuddy.js'
import { cnProfile, enProfile } from '../src/codebuddy/profiles.js'

/** One effect factory a stub context recorded, with the fiber that owns it. */
interface EffectRecord {
  readonly owner: string
  readonly dispose: () => void
}

/**
 * A Cordis context stub exposing only what the plugin touches.
 * @param effects - effects registered on the root context and on the child it
 *   hands to an `inject` callback.
 */
function contextOf(effects: EffectRecord[]) {
  let injectCallback: ((child: unknown) => void) | undefined
  const ctx = {
    llm: { registerAdapter: vi.fn() },
    get: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn() },
    provide: vi.fn(() => () => {}),
    effect: vi.fn((factory: () => (() => void) | void) => {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push({ owner: 'root', dispose })
    }),
    inject: vi.fn((_deps: readonly string[], callback: (child: unknown) => void) => {
      injectCallback = callback
    }),
  }
  return {
    ctx,
    /** Run the authorization branch as the Host does once the seam appears. */
    injectAuthorization(child: unknown) {
      if (injectCallback === undefined) throw new Error('the plugin registered no inject callback')
      injectCallback(child)
    },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('codebuddy plugin', () => {
  it('registers both routes and the service', () => {
    const effects: EffectRecord[] = []
    const { ctx } = contextOf(effects)
    apply(ctx as never, {})
    expect(name).toBe('codebuddy')
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1)
    const [providers] = ctx.llm.registerAdapter.mock.calls[0] ?? []
    expect(providers).toEqual([cnProfile.id, enProfile.id])
    expect(ctx.provide).toHaveBeenCalledWith('codebuddy', expect.anything())
  })

  it('unregisters every sign-in flow when the plugin is unloaded', () => {
    const effects: EffectRecord[] = []
    const { ctx, injectAuthorization } = contextOf(effects)
    apply(ctx as never, {})

    const unregister = [vi.fn(), vi.fn()]
    const child = {
      authorization: {
        registerFlow: vi.fn(() => unregister.shift() as () => void),
      },
      logger: { warn: vi.fn() },
      effect: (factory: () => (() => void) | void) => {
        const dispose = factory()
        if (typeof dispose === 'function') effects.push({ owner: 'authorization', dispose })
      },
    }
    injectAuthorization(child)
    expect(child.authorization.registerFlow).toHaveBeenCalledTimes(2)

    // A reload disposes the injected fiber: each flow key must be released, or
    // the replacement plugin cannot claim it.
    for (const effect of effects.filter(entry => entry.owner === 'authorization')) effect.dispose()
    expect(unregister).toHaveLength(0)
  })

  it('keeps the mounted routes when a flow key is already claimed', () => {
    const effects: EffectRecord[] = []
    const { ctx, injectAuthorization } = contextOf(effects)
    apply(ctx as never, {})
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {})
    const unregister = vi.fn()
    const child = {
      authorization: {
        registerFlow: vi.fn()
          .mockImplementationOnce(() => { throw new Error('duplicate key') })
          .mockImplementation(() => unregister),
      },
      logger: { warn: vi.fn() },
      effect: (factory: () => (() => void) | void) => {
        const dispose = factory()
        if (typeof dispose === 'function') effects.push({ owner: 'authorization', dispose })
      },
    }
    injectAuthorization(child)
    expect(warn).toHaveBeenCalled()
    // Only the flow that registered is released; the failed one has no handle.
    for (const effect of effects.filter(entry => entry.owner === 'authorization')) effect.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
