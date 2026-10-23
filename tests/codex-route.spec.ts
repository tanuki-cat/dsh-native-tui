import { describe, expect, it, vi } from 'vitest'
import {
  countCodexModels,
  ensureCodexRoute,
  removeApiKeyEnvReference,
  removeCodexRoute,
  routeProfile,
} from '../src/codex/route.js'
import type { SettingsAccess, SettingsNamespace } from '../src/runtime/settings-write.js'
import type { SettingsPathOp } from '../src/runtime/settings.js'
import type { ModelCatalog } from '../src/codex/types.js'

/** Assign one path in a mutable settings value. */
function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = root
  for (const key of path.slice(0, -1)) {
    const next: unknown = cursor[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[path[path.length - 1] ?? ''] = value
}

/** Remove one path from a mutable settings value. */
function unsetPath(root: Record<string, unknown>, path: readonly string[]): void {
  let cursor: Record<string, unknown> | undefined = root
  for (const key of path.slice(0, -1)) {
    const next: unknown = cursor?.[key]
    cursor = next !== null && typeof next === 'object' && !Array.isArray(next) ? next as Record<string, unknown> : undefined
  }
  if (cursor !== undefined) delete cursor[path[path.length - 1] ?? '']
}

/** A settings double whose writes can fail once with a revision conflict. */
function settingsOf(initial: Record<string, unknown> = {}) {
  let value = structuredClone(initial)
  let revision = 1
  let conflict = false
  let failures = 0
  const mutate = vi.fn(async (_ns: string, ops: readonly SettingsPathOp[], expected?: number) => {
    if (conflict) {
      conflict = false
      revision += 1
      throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
    }
    if (expected !== undefined && expected !== revision) {
      throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
    }
    for (const op of ops) {
      if (op.op === 'set') setPath(value, op.path, op.value)
      else unsetPath(value, op.path)
    }
    revision += 1
  })
  const service: SettingsAccess = {
    describe: (): readonly SettingsNamespace[] => [{ ns: 'llm-pi-ai', value, revision }],
    mutate,
  }
  return {
    service,
    value: () => value,
    mutate,
    failNext: () => { conflict = true },
    failures: () => failures,
  }
}

/** An LLM double whose route registration can be delayed. */
function llmOf(options: { registered?: boolean; models?: readonly string[]; throws?: boolean } = {}): ModelCatalog & { registered: () => boolean } {
  let registered = options.registered ?? true
  return {
    registered: () => registered,
    listProviders: () => registered ? [{ id: 'openai-codex' }] : [{ id: 'command-code' }],
    listModels: async () => {
      if (options.throws === true) throw new Error('catalogue offline')
      return (options.models ?? ['gpt-6-sol']).map(id => ({ id, name: id }))
    },
  }
}

describe('Codex route setup', () => {
  it('reports a missing or blocked route without writing', () => {
    const settings = settingsOf({ providers: {} })
    expect(routeProfile(settings.service).kind).toBe('missing')
    expect(routeProfile(undefined).kind).toBe('unavailable')
    const blocked = settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY', models: [] } } })
    expect(routeProfile(blocked.service)).toMatchObject({ kind: 'blocked', apiKeyEnv: 'CODEX_API_KEY' })
    expect(blocked.mutate).not.toHaveBeenCalled()
  })

  it('adds the native catalogue route and waits for registration', async () => {
    const settings = settingsOf({ providers: {} })
    const llm = llmOf()
    await expect(ensureCodexRoute(settings.service, llm)).resolves.toEqual({ kind: 'added' })
    expect(settings.value().providers).toEqual({ 'openai-codex': { models: [] } })
  })

  it('leaves an existing route untouched', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { models: [{ id: 'custom' }], reasoning: 'high' } } })
    await expect(ensureCodexRoute(settings.service, llmOf())).resolves.toEqual({ kind: 'present' })
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('retries exactly once on a revision conflict', async () => {
    const settings = settingsOf({ providers: {} })
    settings.failNext()
    await expect(ensureCodexRoute(settings.service, llmOf())).resolves.toEqual({ kind: 'added' })
    expect(settings.mutate).toHaveBeenCalledTimes(2)
  })

  it('does not retry a validation failure', async () => {
    const settings = settingsOf({ providers: {} })
    settings.mutate.mockRejectedValueOnce(new Error('invalid config'))
    await expect(ensureCodexRoute(settings.service, llmOf())).rejects.toThrow('invalid config')
    expect(settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('reports an unverified write when the provider never registers', async () => {
    const settings = settingsOf({ providers: {} })
    const llm = llmOf({ registered: false })
    const state = await ensureCodexRoute(settings.service, llm, { attempts: 2, intervalMs: 0, wait: async () => undefined })
    expect(state).toMatchObject({ kind: 'unverified', added: true })
  })

  it('removes an apiKeyEnv reference and the route', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'KEY', models: [] } } })
    await expect(removeApiKeyEnvReference(settings.service)).resolves.toBe(true)
    expect(routeProfile(settings.service).kind).toBe('present')
    await expect(removeCodexRoute(settings.service)).resolves.toBe(true)
    expect(routeProfile(settings.service).kind).toBe('missing')
  })

  it('returns the catalogue error instead of throwing', async () => {
    await expect(countCodexModels(llmOf({ throws: true }))).resolves.toEqual({ count: 0, error: 'catalogue offline' })
    await expect(countCodexModels(undefined)).resolves.toEqual({ count: 0, error: 'the LLM catalogue service is unavailable' })
  })
})
