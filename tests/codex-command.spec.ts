import { describe, expect, it, vi } from 'vitest'
import { runCodexCommand } from '../src/runtime/codex-command.js'
import { routeProfile } from '../src/codex/route.js'
import type { AuthorizationLike, CredentialStoreLike } from '../src/codex/types.js'
import { catalogBody, catalogFetcher, catalogModel, commandDeps, grant, llmOf, settingsOf, usageFetcher, versionOf } from './codex-fixtures.js'

/** A credential store double over one mutable record. */
function storeOf(initial: Awaited<ReturnType<CredentialStoreLike['readRecord']>> = undefined) {
  let record = initial
  const readRecord = vi.fn(async () => record)
  const deleteRecord = vi.fn(async () => { record = undefined })
  const store: CredentialStoreLike = { readRecord, deleteRecord }
  return { store, readRecord, deleteRecord, stored: () => record }
}

/** An authorization seam double that reports one flow and one outcome. */
function authorizationOf(options: { inFlight?: boolean; outcome?: 'authorized' | 'cancelled'; onBegin?: () => void } = {}): AuthorizationLike {
  return {
    describe: () => ({ inFlight: options.inFlight ?? false, methods: [{ id: 'oauth', label: 'OAuth' }] }),
    begin: async () => {
      options.onBegin?.()
      return { status: options.outcome ?? 'authorized' }
    },
    cancel: vi.fn(),
  }
}

describe('Codex command', () => {
  it('reports a signed-out status with a missing route', async () => {
    const { store } = storeOf()
    const h = commandDeps({ credentials: store, settings: settingsOf({ providers: {} }).service })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('not signed in')
    expect(h.text()).toContain('route openai-codex: missing')
  })

  it('reports a valid account, the route model count and both usage windows', async () => {
    const record = grant()
    const { store } = storeOf(record)
    const usage = usageFetcher()
    const h = commandDeps({
      credentials: store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf({ models: ['gpt-6-sol', 'gpt-5.5'] }),
      authorization: authorizationOf(),
      fetcher: usage.fetcher,
    })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('signed in as Ada (plus)')
    expect(h.text()).toContain('route openai-codex: 2 models')
    expect(h.text()).toContain('5-hour limit  [█████████░] 88% left · 12% used · resets T2000000')
    expect(h.text()).toContain('weekly limit  [██████░░░░] 58% left · 42% used · resets T5000000')
    expect(usage.calls).toHaveLength(1)
    expect(usage.calls[0]?.init?.headers).toEqual({
      authorization: 'Bearer ' + String((record.payload as { access: string }).access),
      'ChatGPT-Account-Id': 'acct-1',
      accept: 'application/json',
    })
  })

  it('flags a route that bypasses OAuth through apiKeyEnv', async () => {
    const { store } = storeOf(grant())
    const h = commandDeps({
      credentials: store,
      settings: settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'CODEX_KEY', models: [] } } }).service,
      llm: llmOf(),
      fetcher: usageFetcher().fetcher,
    })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('OAuth is not used')
  })

  it('skips the usage request when nothing is signed in', async () => {
    const { store } = storeOf()
    const usage = usageFetcher()
    const h = commandDeps({
      credentials: store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: usage.fetcher,
    })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('not signed in')
    expect(usage.calls).toHaveLength(0)
  })

  it('renders the usage reason when the service rejects the credential', async () => {
    const { store } = storeOf(grant())
    const h = commandDeps({
      credentials: store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: usageFetcher({}, 401).fetcher,
    })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('usage: unavailable')
    expect(h.text()).toContain('credential expired')
  })

  it('explains that usage waits for the next openai-codex request when the credential expired', async () => {
    const { store } = storeOf(grant({ expires: 500 }))
    const usage = usageFetcher()
    const h = commandDeps({ credentials: store, fetcher: usage.fetcher })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('refreshes it on the next openai-codex request')
    expect(usage.calls).toHaveLength(0)
  })

  it('asks for a new sign-in when the grant carries no account id', async () => {
    const { store } = storeOf(grant({
      access: 'not-a-jwt',
      accountId: undefined,
    }))
    const usage = usageFetcher()
    const h = commandDeps({ credentials: store, fetcher: usage.fetcher })
    await runCodexCommand('status', h.deps)
    expect(h.text()).toContain('account id')
    expect(usage.calls).toHaveLength(0)
  })

  it('adds the route on setup and reports the catalogue', async () => {
    const settings = settingsOf({ providers: {} })
    const h = commandDeps({ settings: settings.service, llm: llmOf({ models: ['gpt-6-sol', 'gpt-5.5'] }) })
    await runCodexCommand('setup', h.deps)
    expect(settings.value().providers).toEqual({ 'openai-codex': { models: [] } })
    expect(h.text()).toContain('ready (2 models)')
  })

  it('removes an apiKeyEnv reference after confirmation', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'CODEX_KEY', models: [] } } })
    const h = commandDeps({
      settings: settings.service,
      llm: llmOf(),
      choose: async () => 'yes',
    })
    await runCodexCommand('setup', h.deps)
    const route = (settings.value().providers as Record<string, Record<string, unknown>>)['openai-codex']
    expect(route?.apiKeyEnv).toBeUndefined()
    expect(h.text()).toContain('ready')
  })

  it('leaves the route alone when the apiKeyEnv removal is declined', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'CODEX_KEY', models: [] } } })
    const h = commandDeps({ settings: settings.service, llm: llmOf(), choose: async () => 'no' })
    await runCodexCommand('setup', h.deps)
    expect(h.text()).toContain('left unchanged')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('signs in and then configures the route', async () => {
    const { store } = storeOf()
    const settings = settingsOf({ providers: {} })
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm: llmOf({ models: ['gpt-6-sol'] }),
      authorization: authorizationOf(),
    })
    // The seam commits the record during begin: the first read is the guard,
    // the later one sees the stored grant.
    let reads = 0
    store.readRecord = vi.fn(async () => {
      reads += 1
      return reads === 1 ? undefined : grant()
    })
    await runCodexCommand('login', h.deps)
    expect(h.text()).toContain('signed in as Ada (plus)')
    expect(h.text()).toContain('ready (1 models)')
  })

  it('reports a cancelled sign-in without writing the route', async () => {
    const { store } = storeOf()
    const settings = settingsOf({ providers: {} })
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm: llmOf(),
      authorization: authorizationOf({ outcome: 'cancelled' }),
    })
    await runCodexCommand('login', h.deps)
    expect(h.text()).toContain('cancelled')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('refuses a second sign-in while one is in flight', async () => {
    const { store } = storeOf()
    const authorization = authorizationOf({ inFlight: true })
    const begin = vi.spyOn(authorization, 'begin')
    const h = commandDeps({ credentials: store, authorization })
    await runCodexCommand('login', h.deps)
    expect(begin).not.toHaveBeenCalled()
    expect(h.text()).toContain('already running')
  })

  it('signs out after confirmation and warns about the selected model', async () => {
    const { store, deleteRecord } = storeOf(grant())
    const authorization = authorizationOf()
    const cancel = vi.spyOn(authorization, 'cancel')
    const h = commandDeps({
      credentials: store,
      authorization,
      modelSelection: { current: { provider: 'openai-codex', model: 'gpt-6-sol' } },
      choose: async () => 'yes',
    })
    await runCodexCommand('logout', h.deps)
    expect(cancel).toHaveBeenCalledWith('llm-pi-ai/openai-codex')
    expect(deleteRecord).toHaveBeenCalled()
    expect(h.text()).toContain('signed out')
    expect(h.text()).toContain('choose another with /model')
  })

  it('does not sign out without confirmation', async () => {
    const { store, deleteRecord } = storeOf(grant())
    const h = commandDeps({ credentials: store, authorization: authorizationOf(), choose: async () => 'no' })
    await runCodexCommand('logout', h.deps)
    expect(deleteRecord).not.toHaveBeenCalled()
  })

  it('lists models and notes that calls need a sign-in', async () => {
    const { store } = storeOf()
    const h = commandDeps({
      credentials: store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf({ models: ['gpt-6-sol', 'gpt-5.5'] }),
    })
    await runCodexCommand('models', h.deps)
    expect(h.text()).toContain('openai-codex: 2 models')
    expect(h.text()).toContain('gpt-6-sol')
    expect(h.text()).toContain('Calls require sign-in')
  })

  it('points at setup when the route is missing', async () => {
    const h = commandDeps({ settings: settingsOf({ providers: {} }).service, llm: llmOf() })
    await runCodexCommand('models', h.deps)
    expect(h.text()).toContain('run /codex setup')
  })

  it('prints usage for an unknown subcommand', async () => {
    const h = commandDeps()
    await runCodexCommand('nope', h.deps)
    expect(h.text()).toContain('Usage: /codex')
  })

  it('does not delete while a sign-in is still settling', async () => {
    const { store, deleteRecord } = storeOf(grant())
    const h = commandDeps({
      credentials: store,
      authorization: authorizationOf({ inFlight: true }),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('logout', h.deps)
    expect(deleteRecord).not.toHaveBeenCalled()
    expect(h.text()).toContain('still settling')
  })

  it('reports a credential a background refresh wrote back', async () => {
    const { store } = storeOf(grant())
    store.deleteRecord = vi.fn(async () => undefined)
    const h = commandDeps({
      credentials: store,
      authorization: authorizationOf(),
      choose: async () => 'yes',
    })
    await runCodexCommand('logout', h.deps)
    expect(h.text()).toContain('rewritten')
  })

  it('offers to undo a route that never registered', async () => {
    const settings = settingsOf({ providers: {} })
    const h = commandDeps({
      settings: settings.service,
      llm: llmOf({ registered: false }),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('setup', h.deps)
    expect(h.text()).toContain('did not register')
    expect(routeProfile(settings.service).kind).toBe('missing')
  })

  it('redacts credential material from a sign-in failure', async () => {
    const { store } = storeOf()
    const authorization: AuthorizationLike = {
      describe: () => ({ inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }),
      begin: async () => { throw new Error('sign-in failed access_token=SECRETVALUE') },
      cancel: () => undefined,
    }
    const h = commandDeps({ credentials: store, authorization })
    await runCodexCommand('login', h.deps)
    expect(h.text()).toContain('sign-in failed')
    expect(h.text()).not.toContain('SECRETVALUE')
  })
})

describe('Codex catalogue refresh', () => {
  /** The two-model account listing used by the cases below. */
  const listing = catalogBody([
    catalogModel({ slug: 'gpt-6.1-sol' }),
    catalogModel({ slug: 'gpt-6.1-terra' }),
  ])

  /** A signed-in store whose route is present and empty. */
  function signedIn() {
    const { store } = storeOf(grant())
    return { store, settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }) }
  }

  it('refuses before the network when nothing is signed in', async () => {
    const catalogue = catalogFetcher(listing)
    const h = commandDeps({
      credentials: storeOf().store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: catalogue.fetcher,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('not signed in')
    expect(catalogue.calls).toHaveLength(0)
  })

  it('refuses while the credential is expired', async () => {
    const catalogue = catalogFetcher(listing)
    const h = commandDeps({
      credentials: storeOf(grant({ expires: 500 })).store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: catalogue.fetcher,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('credential expired')
    expect(catalogue.calls).toHaveLength(0)
  })

  it('refuses a route that bypasses OAuth', async () => {
    const catalogue = catalogFetcher(listing)
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settingsOf({ providers: { 'openai-codex': { apiKeyEnv: 'CODEX_KEY', models: [] } } }).service,
      llm: llmOf(),
      fetcher: catalogue.fetcher,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('OAuth is not used')
    expect(catalogue.calls).toHaveLength(0)
  })

  it('refuses read-only model settings', async () => {
    const catalogue = catalogFetcher(listing)
    const settings = settingsOf({ providers: { 'openai-codex': { models: [] } } }, { writable: false })
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settings.service,
      llm: llmOf(),
      fetcher: catalogue.fetcher,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('read-only')
    expect(catalogue.calls).toHaveLength(0)
  })

  it('reports a refused credential request', async () => {
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: catalogFetcher(listing, 401).fetcher,
      clientVersion: async () => versionOf(),
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('credential was rejected (401)')
  })

  it('names an unusable request-version override instead of falling back', async () => {
    const catalogue = catalogFetcher(listing)
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settingsOf({ providers: { 'openai-codex': { models: [] } } }).service,
      llm: llmOf(),
      fetcher: catalogue.fetcher,
      clientVersion: async () => ({ error: 'version-invalid' }),
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('DSH_CODEX_CLIENT_VERSION')
    expect(catalogue.calls).toHaveLength(0)
  })

  it('previews the patch and writes nothing when it is declined', async () => {
    const { store, settings } = signedIn()
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm: llmOf({ models: ['gpt-6.1-sol'] }),
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'no',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('remote catalogue 2 models')
    expect(h.text()).toContain('add       gpt-6.1-terra')
    expect(h.text()).toContain('omitted   ultra')
    expect(h.text()).toContain('left unchanged')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('writes the explicit list after confirmation and reports the new model', async () => {
    const { store, settings } = signedIn()
    let applied = false
    const mutate = settings.service.mutate
    settings.service.mutate = async (ns, ops, revision) => {
      await mutate(ns, ops, revision)
      applied = true
    }
    const llm = {
      listProviders: () => [{ id: 'openai-codex' }],
      listModels: async () => (applied ? ['gpt-6.1-sol', 'gpt-6.1-terra'] : ['gpt-6.1-sol'])
        .map(id => ({ id, name: id })),
    }
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm,
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    const saved = settings.value().providers as Record<string, Record<string, unknown>>
    expect((saved['openai-codex']?.models as Array<{ id: string }>).map(model => model.id))
      .toEqual(['gpt-6.1-sol', 'gpt-6.1-terra'])
    expect(h.text()).toContain('2 models registered')
    expect(h.text()).toContain('Added gpt-6.1-terra')
  })

  it('writes the list when no model is new to the runtime', async () => {
    const { store, settings } = signedIn()
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm: llmOf({ models: ['gpt-6.1-sol', 'gpt-6.1-terra'] }),
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(settings.mutate).toHaveBeenCalled()
    expect(h.text()).toContain('No new model was available')
  })

  it('reports that nothing is missing without writing', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-terra' }] } } })
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settings.service,
      llm: llmOf({ models: ['gpt-6.1-sol', 'gpt-6.1-terra'] }),
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('no models to add')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('refuses to merge a list it cannot read', async () => {
    const settings = settingsOf({ providers: { 'openai-codex': { models: { id: 'gpt-6.1-sol' } } } })
    const h = commandDeps({
      credentials: storeOf(grant()).store,
      settings: settings.service,
      llm: llmOf(),
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(h.text()).toContain('cannot be safely merged')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('reports a saved list whose registration never confirmed', async () => {
    const { store, settings } = signedIn()
    const h = commandDeps({
      credentials: store,
      settings: settings.service,
      llm: llmOf({ models: ['gpt-6.1-sol'] }),
      fetcher: catalogFetcher(listing).fetcher,
      clientVersion: async () => versionOf(),
      choose: async () => 'yes',
      wait: async () => undefined,
    })
    await runCodexCommand('models refresh', h.deps)
    expect(settings.mutate).toHaveBeenCalled()
    expect(h.text()).toContain('not confirmed')
  })

  it('prints usage for an unknown models argument without fetching', async () => {
    const catalogue = catalogFetcher(listing)
    const h = commandDeps({ credentials: storeOf(grant()).store, fetcher: catalogue.fetcher })
    await runCodexCommand('models help', h.deps)
    expect(h.text()).toContain('Usage: /codex')
    expect(catalogue.calls).toHaveLength(0)
  })
})
