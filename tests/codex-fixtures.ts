import { vi } from 'vitest'
import type { CodexCommandDeps } from '../src/runtime/codex-command.js'
import type { SettingsPathOp } from '../src/runtime/settings.js'
import type { SettingsAccess, SettingsNamespace } from '../src/runtime/settings-write.js'
import type { CodexGrant, CredentialRecordLike, ModelCatalog } from '../src/codex/types.js'
import type { ClientVersion, ClientVersionSource } from '../src/codex/catalog.js'

/** Encode one JWT with the given claims. */
export function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return encode({ alg: 'none' }) + '.' + encode(claims) + '.signature'
}

/** A Codex grant with display claims. */
export function grant(overrides: Partial<CodexGrant> = {}): CredentialRecordLike {
  return {
    kind: 'grant',
    payload: {
      type: 'oauth',
      access: jwt({
        'https://api.openai.com/profile': { name: 'Ada', email: 'ada@example.com' },
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' },
      }),
      refresh: 'refresh-token',
      expires: 2_000,
      accountId: 'acct-1',
      ...overrides,
    },
  }
}

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
export function settingsOf(
  initial: Record<string, unknown> = {},
  options: { readonly writable?: boolean } = {},
) {
  let value = structuredClone(initial)
  let revision = 1
  let conflict = false
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
    ...(options.writable === undefined ? {} : { writable: options.writable }),
  }
  return { service, value: () => value, mutate, failNext: () => { conflict = true } }
}

/** An LLM double whose route registration can be delayed. */
export function llmOf(options: { registered?: boolean; models?: readonly string[]; throws?: boolean } = {}): ModelCatalog & { registered: () => boolean } {
  const registered = options.registered ?? true
  return {
    registered: () => registered,
    listProviders: () => registered ? [{ id: 'openai-codex' }] : [{ id: 'command-code' }],
    listModels: async () => {
      if (options.throws === true) throw new Error('catalogue offline')
      return (options.models ?? ['gpt-6-sol']).map(id => ({ id, name: id }))
    },
  }
}

/** A `wham/usage` body with both windows and valid percentages. */
export function usageBody(overrides: {
  readonly accountId?: string | null
  readonly fiveHourPercent?: number
  readonly weeklyPercent?: number
  readonly resetAtSeconds?: number
} = {}) {
  const resetAt = overrides.resetAtSeconds ?? 2_000
  return {
    ...(overrides.accountId === null ? {} : { account_id: overrides.accountId ?? 'acct-1' }),
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: overrides.fiveHourPercent ?? 12,
        limit_window_seconds: 18_000,
        reset_after_seconds: 18_000,
        reset_at: resetAt,
      },
      secondary_window: {
        used_percent: overrides.weeklyPercent ?? 42,
        limit_window_seconds: 604_800,
        reset_after_seconds: 604_800,
        reset_at: resetAt + 3_000,
      },
    },
  }
}

/** One remote catalogue entry carrying the fields the reader validates. */
export function catalogModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'gpt-6.1-sol',
    display_name: 'GPT-6.1-Sol',
    visibility: 'list',
    supported_in_api: true,
    context_window: 500_000,
    max_context_window: 872_000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
    ...overrides,
  }
}

/** A `codex/models` body. */
export function catalogBody(models: readonly unknown[] = [catalogModel()]): unknown {
  return { models }
}

/** A resolved catalogue request version. */
export function versionOf(value = '0.165.0', source: ClientVersionSource = 'builtin'): ClientVersion {
  return { value, source }
}

/** A fetch double that serves one catalogue body and records every call. */
export function catalogFetcher(
  body: unknown = catalogBody(),
  status = 200,
  headers: Record<string, string> = {},
) {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  return { fetcher: fetcher as typeof fetch, calls }
}

/** A fetch double that serves one usage body and records every call. */
export function usageFetcher(body: unknown = usageBody(), status = 200) {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetcher: fetcher as typeof fetch, calls }
}

/** A command harness that records notices and defaults to no answers. */
export function commandDeps(overrides: Partial<CodexCommandDeps> = {}) {
  const notices: Array<{ readonly level: string; readonly text: string }> = []
  const deps: CodexCommandDeps = {
    notice: (level, text) => { notices.push({ level, text }) },
    choose: async () => undefined,
    ask: async () => undefined,
    signal: new AbortController().signal,
    now: () => 1_000,
    formatTime: ms => 'T' + String(ms),
    ...overrides,
  }
  return { deps, notices, text: () => notices.map(notice => notice.text).join('\n') }
}
