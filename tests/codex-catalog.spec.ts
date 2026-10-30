import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CLIENT_VERSION,
  DEFAULT_CODEX_MAX_OUTPUT_TOKENS,
  fetchCodexCatalog,
  parseRemoteCatalog,
  planCatalogPatch,
  resolveClientVersion,
} from '../src/codex/catalog.js'
import type { CatalogListing } from '../src/codex/catalog.js'
import { catalogBody, catalogFetcher, catalogModel } from './codex-fixtures.js'

/** Run one fetch against a double with a fresh command signal. */
function fetchWith(fetcher: typeof fetch, extra: { signal?: AbortSignal } = {}) {
  return fetchCodexCatalog({
    access: 'access-token',
    accountId: 'acct-1',
    clientVersion: '0.165.0',
    signal: extra.signal ?? new AbortController().signal,
    fetcher,
  })
}

/** The readable listing of one body, failing the test when it is not readable. */
function listingOf(body: unknown): CatalogListing {
  const result = parseRemoteCatalog(body)
  if (result.kind !== 'ok') throw new Error('expected a readable listing, got ' + result.reason)
  return result
}

describe('catalogue parsing', () => {
  it('keeps listed models and skips hidden ones', () => {
    const listing = listingOf(catalogBody([
      catalogModel({ slug: 'gpt-6.1-sol' }),
      catalogModel({ slug: 'codex-auto-review', visibility: 'hide' }),
    ]))
    expect(listing.entries.map(entry => entry.id)).toEqual(['gpt-6.1-sol'])
    expect(listing.total).toBe(2)
  })

  it('refuses an envelope that is not the listing it claims to be', () => {
    expect(parseRemoteCatalog({ data: [] })).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    expect(parseRemoteCatalog({ models: [], next_page: 'x' })).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    expect(parseRemoteCatalog(null)).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('refuses duplicate or malformed model ids', () => {
    expect(parseRemoteCatalog(catalogBody([
      catalogModel({ slug: 'gpt-6.1-sol' }),
      catalogModel({ slug: 'gpt-6.1-sol' }),
    ]))).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    expect(parseRemoteCatalog(catalogBody([catalogModel({ slug: 'GPT-6.1' })])))
      .toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    expect(parseRemoteCatalog(catalogBody([catalogModel({ slug: '' })])))
      .toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('falls back to the ceiling window and defaults modalities to text', () => {
    const listing = listingOf(catalogBody([catalogModel({
      context_window: undefined,
      input_modalities: undefined,
    })]))
    expect(listing.entries[0]?.contextWindow).toBe(872_000)
    expect(listing.entries[0]?.input).toEqual(['text'])
  })

  it('reports levels the Host cannot express and keeps the rest', () => {
    const listing = listingOf(catalogBody([catalogModel({ slug: 'gpt-6.1-terra' })]))
    expect(listing.entries[0]?.omitted).toEqual(['ultra'])
    expect(listing.limited).toEqual([{ id: 'gpt-6.1-terra', omitted: ['ultra'] }])
    expect(listing.entries[0]?.efforts).toEqual({
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })

  it('skips an entry whose only level is unexpressible and counts it', () => {
    const listing = listingOf(catalogBody([
      catalogModel({ slug: 'gpt-6.1-terra', supported_reasoning_levels: [{ effort: 'ultra' }] }),
      catalogModel({ slug: 'gpt-6.1-sol' }),
    ]))
    expect(listing.entries.map(entry => entry.id)).toEqual(['gpt-6.1-sol'])
    expect(listing.unsupported).toBe(1)
  })

  it('marks a model that declares no levels as non-reasoning', () => {
    const listing = listingOf(catalogBody([catalogModel({ supported_reasoning_levels: [] })]))
    expect(listing.entries[0]?.efforts).toBe(false)
  })

  it('refuses an empty or oversized listing', () => {
    expect(parseRemoteCatalog({ models: [] })).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    const many = Array.from({ length: 501 }, (_, index) => catalogModel({ slug: 'model-' + String(index) }))
    expect(parseRemoteCatalog(catalogBody(many))).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })
})

describe('catalogue request', () => {
  it('sends the credential, the account id and the request version', async () => {
    const { fetcher, calls } = catalogFetcher()
    const result = await fetchWith(fetcher)
    expect(result.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.165.0')
    expect(calls[0]?.init?.headers).toEqual({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'acct-1',
      accept: 'application/json',
    })
    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('maps refusals to distinct reasons', async () => {
    expect(await fetchWith(catalogFetcher(catalogBody(), 401).fetcher))
      .toEqual({ kind: 'unavailable', reason: 'credential-expired', status: 401 })
    expect(await fetchWith(catalogFetcher(catalogBody(), 403).fetcher))
      .toEqual({ kind: 'unavailable', reason: 'permission-denied', status: 403 })
    expect(await fetchWith(catalogFetcher(catalogBody(), 429).fetcher))
      .toEqual({ kind: 'unavailable', reason: 'rate-limited', status: 429 })
    expect(await fetchWith(catalogFetcher(catalogBody(), 503).fetcher))
      .toEqual({ kind: 'unavailable', reason: 'network-error', status: 503 })
  })

  it('refuses a body that is not JSON', async () => {
    const result = await fetchWith(catalogFetcher('<html>', 200, { 'content-type': 'text/html' }).fetcher)
    expect(result).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('refuses a declared length above the cap without reading it', async () => {
    const result = await fetchWith(catalogFetcher(catalogBody(), 200, {
      'content-length': String(4 * 1024 * 1024 + 1),
    }).fetcher)
    expect(result).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('refuses an undeclared body that outgrows the cap while reading', async () => {
    const huge = JSON.stringify(catalogBody([catalogModel({ display_name: 'x'.repeat(4 * 1024 * 1024) })]))
    const result = await fetchWith(catalogFetcher(huge).fetcher)
    expect(result).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('reports a transport failure as a network error', async () => {
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchWith(failing)).toEqual({ kind: 'unavailable', reason: 'network-error' })
  })

  it('stays quiet when the command was cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await fetchWith(catalogFetcher().fetcher, { signal: controller.signal })
    expect(result).toEqual({ kind: 'unavailable', reason: 'cancelled' })
  })
})

describe('request version', () => {
  it('prefers a valid environment override', async () => {
    expect(await resolveClientVersion('0.162.0', async () => 'codex-cli 0.165.0'))
      .toEqual({ value: '0.162.0', source: 'environment' })
  })

  it('refuses an invalid override instead of falling back', async () => {
    expect(await resolveClientVersion('latest', async () => 'codex-cli 0.165.0'))
      .toEqual({ error: 'version-invalid' })
    expect(await resolveClientVersion('', async () => 'codex-cli 0.165.0'))
      .toEqual({ error: 'version-invalid' })
  })

  it('reads the installed CLI version', async () => {
    expect(await resolveClientVersion(null, async () => 'codex-cli 0.165.0\n'))
      .toEqual({ value: '0.165.0', source: 'codex-cli' })
    expect(await resolveClientVersion(null, async () => 'codex 0.164.0'))
      .toEqual({ value: '0.164.0', source: 'codex-cli' })
  })

  it('falls back to the built-in version when the probe is unusable', async () => {
    const failing = async () => { throw new Error('ENOENT') }
    expect(await resolveClientVersion(null, failing))
      .toEqual({ value: BUILTIN_CLIENT_VERSION, source: 'builtin' })
    expect(await resolveClientVersion(null, async () => 'not a version'))
      .toEqual({ value: BUILTIN_CLIENT_VERSION, source: 'builtin' })
  })
})

describe('patch planning', () => {
  const listing = listingOf(catalogBody([
    catalogModel({ slug: 'gpt-6.1-sol' }),
    catalogModel({ slug: 'gpt-6.1-terra' }),
  ]))

  it('preserves explicit entries verbatim and appends the missing ones', () => {
    const plan = planCatalogPatch(
      [{ id: 'gpt-6.1-sol', contextWindow: 400_000, reasoningEfforts: { low: 'low' } }],
      [{ id: 'gpt-6.1-sol' }],
      listing,
    )
    if ('error' in plan) throw new Error('expected a plan')
    expect(plan.preserved).toEqual(['gpt-6.1-sol'])
    expect(plan.added).toEqual(['gpt-6.1-terra'])
    expect(plan.newlyAvailable).toEqual(['gpt-6.1-terra'])
    expect(plan.proposed[0]).toEqual({ id: 'gpt-6.1-sol', contextWindow: 400_000, reasoningEfforts: { low: 'low' } })
    expect(plan.proposed[1]).toMatchObject({ id: 'gpt-6.1-terra', contextWindow: 500_000 })
  })

  it('adds registered ids the listing does not carry and reports them', () => {
    const plan = planCatalogPatch([], [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.9-legacy' }], listing)
    if ('error' in plan) throw new Error('expected a plan')
    expect(plan.proposed.map(entry => (entry as { id: string }).id))
      .toEqual(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.9-legacy'])
    expect(plan.newlyAvailable).toEqual(['gpt-6.1-terra'])
    expect(plan.unlisted).toEqual(['gpt-5.9-legacy'])
  })

  it('writes declared defaults for a model the listing leaves bare', () => {
    const bare = listingOf(catalogBody([catalogModel({ slug: 'gpt-6.1-terra', max_output_tokens: undefined })]))
    const plan = planCatalogPatch(undefined, [], bare)
    if ('error' in plan) throw new Error('expected a plan')
    expect(plan.proposed[0]).toMatchObject({
      id: 'gpt-6.1-terra',
      maxTokens: DEFAULT_CODEX_MAX_OUTPUT_TOKENS,
      input: ['image', 'text'],
    })
  })

  it('refuses a list it cannot merge safely', () => {
    expect(planCatalogPatch({ models: [] }, [], listing)).toEqual({ error: 'config-unmergeable' })
    expect(planCatalogPatch([{ noId: true }], [], listing)).toEqual({ error: 'config-unmergeable' })
    expect(planCatalogPatch([{ id: 'a' }, { id: 'a' }], [], listing)).toEqual({ error: 'config-unmergeable' })
  })
})
