import { describe, expect, it } from 'vitest'
import { findSettingsNamespace, isSettingsConflict, writeSettingsOps } from '../src/ui/commands/settings-common.js'
import type { SettingsService } from '../src/ui/commands/services.js'

/** Minimal descriptor shape the helpers read. */
function descriptor(ns: string, revision: number) {
  return {
    ns,
    schema: {},
    value: {},
    revision,
    applies: 'live' as const,
    autoGenerate: true,
  }
}

/** Stub service that records writes. */
function serviceOf(rows: ReturnType<typeof descriptor>[], mutate: (revision?: number) => void): SettingsService {
  return {
    describe: () => rows,
    update: async () => undefined,
    mutate: async (_ns, _ops, revision) => { mutate(revision) },
  }
}

describe('findSettingsNamespace', () => {
  it('returns the matching descriptor or undefined', () => {
    const settings = serviceOf([descriptor('a', 1), descriptor('b', 2)], () => undefined)
    expect(findSettingsNamespace(settings, 'b')?.revision).toBe(2)
    expect(findSettingsNamespace(settings, 'missing')).toBeUndefined()
  })
})

describe('isSettingsConflict', () => {
  it('recognizes the Host revision refusal only', () => {
    expect(isSettingsConflict({ code: 'SETTINGS_CONFLICT' })).toBe(true)
    expect(isSettingsConflict({ code: 'OTHER' })).toBe(false)
    expect(isSettingsConflict(new Error('x'))).toBe(false)
    expect(isSettingsConflict(null)).toBe(false)
  })
})

describe('writeSettingsOps', () => {
  it('writes once and returns the refreshed descriptor', async () => {
    const revisions: (number | undefined)[] = []
    const settings = serviceOf([descriptor('demo', 4)], revision => { revisions.push(revision) })
    const fresh = await writeSettingsOps(settings, 'demo', [{ op: 'set', path: ['x'], value: 1 }], 4)
    expect(revisions).toEqual([4])
    expect(fresh?.ns).toBe('demo')
  })

  it('retries once at the fresh revision after a conflict', async () => {
    const revisions: (number | undefined)[] = []
    let fail = true
    const settings: SettingsService = {
      describe: () => [descriptor('demo', fail ? 9 : 9)],
      update: async () => undefined,
      mutate: async (_ns, _ops, revision) => {
        revisions.push(revision)
        if (fail) {
          fail = false
          throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
        }
      },
    }
    await writeSettingsOps(settings, 'demo', [{ op: 'unset', path: ['x'] }], 8)
    expect(revisions).toEqual([8, 9])
  })

  it('does not retry unrelated failures', async () => {
    const settings: SettingsService = {
      describe: () => [descriptor('demo', 1)],
      update: async () => undefined,
      mutate: async () => { throw new Error('boom') },
    }
    await expect(writeSettingsOps(settings, 'demo', [], 1)).rejects.toThrow('boom')
  })
})
