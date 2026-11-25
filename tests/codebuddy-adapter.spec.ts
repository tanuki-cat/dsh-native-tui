import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  accessToken,
  credentialKeyFor,
  grantOf,
  login,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  refreshGrant,
  toGrant,
  type CodeBuddyGrant,
  type CredentialRecordLike,
  type CredentialStoreLike,
} from '../src/codebuddy/auth.js'
import { CodeBuddyAdapter } from '../src/codebuddy/adapter.js'
import { cnProfile } from '../src/codebuddy/profiles.js'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

const DAY = 24 * 60 * 60 * 1000

/** One in-memory credential seam with the modifyRecord contract. */
function storeOf(initial?: CredentialRecordLike): CredentialStoreLike & { current(): CredentialRecordLike | undefined } {
  let current = initial
  return {
    current: () => current,
    async readRecord() { return current },
    async modifyRecord(_key, mutate) {
      const next = await mutate(current)
      if (next !== undefined) current = next
      return current
    },
    async deleteRecord() { current = undefined },
  }
}

/** A grant record that is already due for rotation. */
const expiredRecord: CredentialRecordLike = { kind: 'grant', payload: { access: 'old', refresh: 'r1', expires: Date.now() - DAY } }
const freshRecord: CredentialRecordLike = { kind: 'grant', payload: { access: 'good', refresh: 'r1', expires: Date.now() + DAY } }

/** One request body for a direct adapter stream call. */
function optionsOf(overrides: Record<string, unknown>): GenerateOptions {
  return { provider: 'codebuddy', model: 'chat-a', messages: [], ...overrides } as unknown as GenerateOptions
}

/** Drain a chunk stream. */
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('codebuddy grants', () => {
  it('normalizes a token payload', () => {
    const grant = toGrant({ accessToken: 'a', refreshToken: 'r', expiresIn: 7 * 24 * 3600 }, 0)
    expect(grant).toEqual({ access: 'a', refresh: 'r', expires: 6 * DAY })
    expect(() => toGrant({}, 0)).toThrowError(/accessToken/u)
    expect(grantOf({ kind: 'api-key', payload: { key: 'x' } })).toBeUndefined()
    expect(grantOf({ kind: 'grant', payload: { access: '' } })).toBeUndefined()
  })

  it('rotates through the record lock and keeps the old refresh token when omitted', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string>, body: string }) => {
      seen.push(init.headers['X-Refresh-Token'] ?? '')
      return new Response(JSON.stringify({ code: 0, data: { accessToken: 'new', expiresIn: 7 * 24 * 3600 } }))
    })
    const rotated = await refreshGrant(cnProfile, grantOf(expiredRecord) as CodeBuddyGrant, undefined)
    expect(seen).toEqual(['r1'])
    expect(rotated.access).toBe('new')
    expect(rotated.refresh).toBe('r1')
  })

  it('refuses to rotate without a refresh token', async () => {
    await expect(refreshGrant(cnProfile, { access: 'a', refresh: '', expires: 0 }, undefined))
      .rejects.toMatchObject({ fatal: true })
  })
})

describe('codebuddy access tokens', () => {
  it('requires a stored credential', async () => {
    await expect(accessToken(storeOf(), cnProfile, undefined)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('returns a fresh token without a network call', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('should not be called') })
    expect(await accessToken(storeOf(freshRecord), cnProfile, undefined)).toBe('good')
  })

  it('rotates an expired token and persists it', async () => {
    const store = storeOf(expiredRecord)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'rotated', refreshToken: 'r2', expiresIn: 7 * 24 * 3600 },
    })))
    expect(await accessToken(store, cnProfile, undefined)).toBe('rotated')
    expect(grantOf(store.current())).toMatchObject({ access: 'rotated', refresh: 'r2' })
  })

  it('rotates on demand for a controlled replay', async () => {
    const store = storeOf(freshRecord)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0, data: { accessToken: 'forced', expiresIn: 3600 } })))
    expect(await accessToken(store, cnProfile, undefined, true)).toBe('forced')
  })

  it('reuses a token a concurrent request already rotated for the rejected one', async () => {
    // The gateway refused 'stale'; the stored token is already a newer one, so
    // rotating again would invalidate the token the other request just minted.
    vi.stubGlobal('fetch', async () => { throw new Error('must not rotate a second time') })
    expect(await accessToken(storeOf(freshRecord), cnProfile, undefined, true, 'stale')).toBe('good')
  })

  it('still rotates when the stored token is the one the gateway refused', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0, data: { accessToken: 'next', expiresIn: 604800 } })))
    expect(await accessToken(storeOf(freshRecord), cnProfile, undefined, true, 'good')).toBe('next')
  })

  it('reports a concurrent deletion instead of returning the stale grant', async () => {
    let record: CredentialRecordLike | undefined = expiredRecord
    const store: CredentialStoreLike = {
      async readRecord() { return record },
      async modifyRecord() {
        // A logout deleted the record while this rotation waited for the lock.
        record = undefined
        return undefined
      },
      async deleteRecord() { record = undefined },
    }
    await expect(accessToken(store, cnProfile, undefined)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('reports cancellation as ABORTED instead of an auth failure', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async () => {
      controller.abort()
      throw new Error('The operation was aborted')
    })
    await expect(accessToken(storeOf(expiredRecord), cnProfile, controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('codebuddy login flow', () => {
  it('requests a link, polls and commits the grant', async () => {
    vi.useFakeTimers()
    let polls = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's1', authUrl: 'https://auth.example/x' } }))
      }
      polls += 1
      if (polls === 1) return new Response(JSON.stringify({ code: 11217 }))
      return new Response(JSON.stringify({ code: 0, data: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 604800 } }))
    })
    const committed: unknown[] = []
    const notices: (string | undefined)[] = []
    const promise = login(cnProfile, {
      signal: new AbortController().signal,
      notify: notice => { notices.push(notice.url) },
      commit: async (record) => { committed.push(record) },
    })
    await vi.advanceTimersByTimeAsync(11_000)
    const grant = await promise
    expect(grant.access).toBe('a1')
    expect(committed).toHaveLength(1)
    expect(notices).toContain('https://auth.example/x')
    expect(polls).toBe(2)
  })

  it('stops a pending login when the attempt is cancelled', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'u' } })))
    const controller = new AbortController()
    const promise = login(cnProfile, {
      signal: controller.signal,
      notify: () => {},
      commit: async () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(promise).rejects.toThrowError()
  })

  it('never commits a grant once the attempt was cancelled', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'u' } }))
      }
      // The cancel lands after the gateway answered but before the grant is
      // committed: the credential must not be written back.
      controller.abort()
      return new Response(JSON.stringify({ code: 0, data: { accessToken: 'resurrected', expiresIn: 604800 } }))
    })
    const committed: unknown[] = []
    const promise = login(cnProfile, {
      signal: controller.signal,
      notify: () => {},
      commit: async (record) => { committed.push(record) },
    })
    const settled = expect(promise).rejects.toThrowError(/cancelled/u)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10)
    await settled
    expect(committed).toHaveLength(0)
  })

  it('reports a refused poll instead of waiting out the deadline', async () => {
    vi.useFakeTimers()
    for (const status of [401, 403, 429, 500]) {
      vi.stubGlobal('fetch', async (url: string) => {
        if (String(url).includes('/auth/state')) {
          return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'u' } }))
        }
        return new Response(JSON.stringify({ code: 9000 + status, msg: 'refused' }), { status })
      })
      const committed: unknown[] = []
      const promise = login(cnProfile, {
        signal: new AbortController().signal,
        notify: () => {},
        commit: async (record) => { committed.push(record) },
      })
      const settled = expect(promise).rejects.toMatchObject({ name: 'GatewayError' })
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10)
      await settled
      expect(committed).toHaveLength(0)
    }
  })

  it('aborts a hung poll at the login deadline', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.stubGlobal('fetch', async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 's', authUrl: 'u' } }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('deadline reached'))
        }, { once: true })
      })
    })
    const promise = login(cnProfile, {
      signal: new AbortController().signal,
      notify: () => {},
      commit: async () => {},
    })
    const settled = expect(promise).rejects.toThrowError(/timed out/u)
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS + 10)
    await settled
    // The request itself was aborted, not merely abandoned by the loop.
    expect(aborted).toBe(true)
  })
})

describe('codebuddy adapter', () => {
  const catalogue = JSON.stringify({
    code: 0,
    data: {
      models: [{
        id: 'chat-a',
        maxInputTokens: 5000,
        maxOutputTokens: 1000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'max'], canDisableThinking: false },
      }],
    },
  })

  it('advertises both routes with seed models when no credential store is mounted', async () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    expect(adapter.providerInfo('codebuddy').name).toBe('CodeBuddy (CN)')
    expect(adapter.providerInfo('codebuddy-en').name).toBe('CodeBuddy (WorkBuddy EN)')
    expect(await adapter.listModels('codebuddy')).toHaveLength(cnProfile.seedModels.length)
    expect(adapter.status().map(entry => entry.id)).toEqual(['codebuddy', 'codebuddy-en'])
  })

  it('owns only the two CodeBuddy routes', () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    expect(adapter.providerInfo('codebuddy').id).toBe('codebuddy')
    expect(adapter.providerInfo('codebuddy-en').id).toBe('codebuddy-en')
    // The system-prompt override lives in this adapter's wire layer, so a
    // provider this adapter does not own can never receive it.
    expect(() => adapter.providerInfo('deepseek')).toThrowError(/does not own provider/u)
  })

  it('refreshes the catalogue and exposes exact model metadata', async () => {
    const store = storeOf(freshRecord)
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      return new Response(catalogue)
    })
    const adapter = new CodeBuddyAdapter({ store: () => store })
    const outcomes = await adapter.refresh('codebuddy')
    expect(outcomes).toEqual([{ id: 'codebuddy' }])
    expect(seen[0]).toBe('https://copilot.tencent.com/v3/config')
    const info = await adapter.resolveModel('codebuddy', 'chat-a')
    expect(info.context?.contextWindow).toBe(5000)
    expect(info.defaultMaxTokens).toBe(1000)
    // canDisableThinking is false, so no off level is offered.
    expect(info.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'max'])
    expect((await adapter.listModels('codebuddy')).map(model => model.id)).toEqual(['chat-a'])
  })

  it('replays a truncated stream on top of the host retry defaults', () => {
    const policy = new CodeBuddyAdapter({ store: () => undefined }).providerRetryPolicy('codebuddy')
    expect(policy.mode).toBe('normal')
    const codes = policy.mode === 'normal' ? policy.retryableCodes : []
    // INCOMPLETE_STREAM is this adapter's own truncated-stream code; the rest
    // must stay, because they are what recovers a dropped connection.
    expect(codes).toContain('INCOMPLETE_STREAM')
    for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE']) {
      expect(codes).toContain(code)
    }
  })

  it('keeps a conservative fallback for an unlisted model', async () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    const info = await adapter.resolveModel('codebuddy', 'not-in-the-catalogue')
    expect(info.context?.contextWindow).toBe(200_000)
    expect(info.reasoning).toBeUndefined()
    // An id outside the catalogue makes no capability claim.
    expect(info.inputModalities).toEqual(['text'])
  })

  it('reads the catalogue before answering a capability question on a cold route', async () => {
    // A selected effort is validated against these levels before the first
    // turn; answering from the seed list would report none and reject it.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: {
        models: [{
          id: 'reasoning-model',
          supportsReasoning: true,
          reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: false },
        }],
      },
    })))
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    const info = await adapter.resolveModel('codebuddy', 'reasoning-model')
    expect(info.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'high', 'max'])
    // prepareCall is the path a dispatched turn takes, and needs the same answer.
    const prepared = await adapter.prepareCall('codebuddy', 'reasoning-model')
    expect(prepared.model.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'high', 'max'])
  })

  it('spends at most one catalogue request while the refresh stays fresh', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      return new Response(catalogue)
    })
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    await adapter.resolveModel('codebuddy', 'chat-a')
    await adapter.resolveModel('codebuddy', 'chat-a')
    await adapter.prepareCall('codebuddy', 'chat-a')
    await adapter.listModels('codebuddy')
    expect(fetches).toBe(1)
  })

  it('still answers a capability question when the catalogue cannot be read', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('socket closed') })
    const diagnostics: string[] = []
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      onDiagnostic: message => { diagnostics.push(message) },
    })
    // The seed list is the only answer left; the turn fails on capability
    // rather than on a transport error the user cannot act on.
    const info = await adapter.resolveModel('codebuddy', 'chat-a')
    expect(info.inputModalities).toEqual(['text'])
    expect(diagnostics.some(message => message.includes('socket closed'))).toBe(true)
  })

  it('rotates an expired credential before reading the catalogue', async () => {
    const store = storeOf(expiredRecord)
    const seen: string[] = []
    const authorized: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(String(url))
      if (String(url).includes('/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'rotated', expiresIn: 604800 } }))
      }
      authorized.push(init.headers.Authorization ?? '')
      return new Response(catalogue)
    })
    const adapter = new CodeBuddyAdapter({ store: () => store })
    await adapter.refresh('codebuddy')
    // The catalogue is read with a request-ready token, not the stored dead one.
    expect(seen[0]).toContain('/token/refresh')
    expect(authorized).toEqual(['Bearer rotated'])
  })

  it('merges the caller signal into the catalogue request', async () => {
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => {
      seen = init.signal
      return new Response(catalogue)
    })
    const controller = new AbortController()
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    await adapter.resolveModel('codebuddy', 'chat-a', controller.signal)
    expect(seen).toBeDefined()
    // The forwarded signal is the caller's plus the module's timeout, so a host
    // cancel reaches the request and the request still has its own ceiling.
    expect(seen).not.toBe(controller.signal)
    expect(seen?.aborted).toBe(false)
    controller.abort()
    expect(seen?.aborted).toBe(true)
  })

  it('backs off after a failed catalogue refresh', async () => {
    const base = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(base)
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      throw new Error('socket closed')
    })
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    await adapter.resolveModel('codebuddy', 'chat-a')
    await adapter.resolveModel('codebuddy', 'chat-a')
    await adapter.listModels('codebuddy')
    // The outage is remembered: a turn made during the cooldown answers from the
    // seed list instead of stalling for the request timeout again.
    expect(fetches).toBe(1)
    expect(adapter.status()[0]?.lastError).toContain('socket closed')

    now.mockReturnValue(base + 31_000)
    await adapter.listModels('codebuddy')
    expect(fetches).toBe(2)
    now.mockRestore()
  })

  it('retries at once when the credential changed after a failure', async () => {
    let record: CredentialRecordLike | undefined = { kind: 'grant', payload: { access: 'old', refresh: 'r1', expires: Date.now() + DAY } }
    const store: CredentialStoreLike = {
      async readRecord() { return record },
      async modifyRecord(_key, mutate) {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      },
      async deleteRecord() { record = undefined },
    }
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      throw new Error('socket closed')
    })
    const adapter = new CodeBuddyAdapter({ store: () => store })
    await adapter.resolveModel('codebuddy', 'chat-a')
    expect(fetches).toBe(1)
    // A fresh sign-in writes a new access token; the recorded outage was about
    // the old credential, so the route tries again instead of waiting it out.
    record = { kind: 'grant', payload: { access: 'new', refresh: 'r1', expires: Date.now() + DAY } }
    await adapter.resolveModel('codebuddy', 'chat-a')
    expect(fetches).toBe(2)
  })

  it('lets an explicit refresh bypass the failure cooldown', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      throw new Error('socket closed')
    })
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    expect((await adapter.refresh('codebuddy'))[0]?.error).toContain('socket closed')
    await adapter.listModels('codebuddy')
    expect(fetches).toBe(1)
    // A human asking again is not a turn: the cooldown must not swallow it.
    expect((await adapter.refresh('codebuddy'))[0]?.error).toContain('socket closed')
    expect(fetches).toBe(2)
  })

  it('does not cooldown-lock a route that is only missing a sign-in', async () => {
    let record: CredentialRecordLike | undefined
    const store: CredentialStoreLike = {
      async readRecord() { return record },
      async modifyRecord(_key, mutate) {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      },
      async deleteRecord() { record = undefined },
    }
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      return new Response(catalogue)
    })
    const adapter = new CodeBuddyAdapter({ store: () => store })
    await adapter.resolveModel('codebuddy', 'chat-a')
    expect(fetches).toBe(0)
    expect(adapter.status()[0]?.lastError).toBe('not signed in')
    // Signing in repairs the route immediately; no cooldown outlives the login.
    record = freshRecord
    await adapter.resolveModel('codebuddy', 'chat-a')
    expect(fetches).toBe(1)
    expect(adapter.status()[0]?.lastError).toBeUndefined()
  })

  it('declares the modalities the catalogue states, once an attachment service is mounted', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: {
        models: [
          { id: 'vision', supportsImages: true },
          { id: 'textual', supportsImages: false },
          { id: 'switched-off', supportsImages: true, disabledMultimodal: true },
        ],
      },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      resolveAttachments: () => ({
        async readImageRequest() { seen.push('read'); return { data: new Uint8Array(), mediaType: 'image/png' } },
      }),
    })
    await adapter.refresh('codebuddy')
    const modalities = new Map((await adapter.listModels('codebuddy')).map(model => [model.id, model.inputModalities]))
    expect(modalities.get('vision')).toEqual(['text', 'image'])
    expect(modalities.get('textual')).toEqual(['text'])
    expect(modalities.get('switched-off')).toEqual(['text'])
    expect((await adapter.resolveModel('codebuddy', 'vision')).inputModalities).toEqual(['text', 'image'])
    expect(seen).toEqual([])
  })

  it('stays text-only without an attachment service, even when the catalogue declares images', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'vision', supportsImages: true }] },
    })))
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    await adapter.refresh('codebuddy')
    // Bytes cannot be produced, so declaring images would only fail the turn later.
    expect((await adapter.listModels('codebuddy'))[0]?.inputModalities).toEqual(['text'])
    expect((await adapter.resolveModel('codebuddy', 'vision')).inputModalities).toEqual(['text'])
  })

  it('reports which declarations the missing attachment service narrowed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'vision', supportsImages: true }, { id: 'textual', supportsImages: false }] },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      // The operator says this model reads images; the catalogue disagrees.
      models: { textual: { input: ['text', 'image'] } },
    })
    await adapter.refresh('codebuddy')
    const byId = new Map(adapter.models('codebuddy').map(model => [model.id, model]))
    // Both wanted images and both were narrowed, whichever layer asked.
    expect(byId.get('vision')?.degraded).toBe('no-attachment-service')
    expect(byId.get('textual')?.degraded).toBe('no-attachment-service')
    expect(byId.get('textual')?.source).toBe('override')
    // The declaration in force before the narrowing is what makes the report
    // honest: the operator override is named even though the catalogue said no.
    expect(byId.get('textual')?.declaredModalities).toEqual(['text', 'image'])
    expect(byId.get('textual')?.statedModalities).toEqual(['text'])
    expect(byId.get('textual')?.inputModalities).toEqual(['text'])
  })

  it('leaves a text-only declaration undegraded', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'textual', supportsImages: false }] },
    })))
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    await adapter.refresh('codebuddy')
    const summary = adapter.models('codebuddy')[0]
    // Nothing asked for images, so no attachment service is being missed.
    expect(summary?.degraded).toBeUndefined()
    expect(summary?.declaredModalities).toEqual(['text'])
  })

  it('leaves an override undegraded once an attachment service is mounted', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'textual', supportsImages: false }] },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      models: { textual: { input: ['text', 'image'] } },
      resolveAttachments: () => ({ async readImageRequest() { return { data: new Uint8Array(), mediaType: 'image/png' } } }),
    })
    await adapter.refresh('codebuddy')
    const summary = adapter.models('codebuddy')[0]
    expect(summary?.degraded).toBeUndefined()
    expect(summary?.inputModalities).toEqual(['text', 'image'])
  })

  it('lets a per-model override correct the catalogue', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'default', supportsImages: false }, { id: 'vision', supportsImages: true }] },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      resolveAttachments: () => ({ async readImageRequest() { return { data: new Uint8Array(), mediaType: 'image/png' } } }),
      // Measured: this model declares no images and still reads them.
      models: { default: { input: ['text', 'image'] }, vision: { input: ['text'] } },
    })
    await adapter.refresh('codebuddy')
    const byId = new Map((await adapter.listModels('codebuddy')).map(model => [model.id, model.inputModalities]))
    expect(byId.get('default')).toEqual(['text', 'image'])
    expect(byId.get('vision')).toEqual(['text'])
    expect((await adapter.resolveModel('codebuddy', 'default')).inputModalities).toEqual(['text', 'image'])
  })

  it('treats an empty override as no override', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'vision', supportsImages: true }, { id: 'textual', supportsImages: false }] },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      resolveAttachments: () => ({ async readImageRequest() { return { data: new Uint8Array(), mediaType: 'image/png' } } }),
      // The schema fills a written but empty input with [], which must not be
      // read as "this model accepts nothing".
      models: { vision: { input: [] }, textual: { input: [] } },
    })
    await adapter.refresh('codebuddy')
    const byId = new Map(adapter.models('codebuddy').map(model => [model.id, model]))
    expect(byId.get('vision')?.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('textual')?.inputModalities).toEqual(['text'])
    // An empty override is not a claim, so the catalogue stays the source.
    expect(byId.get('vision')?.source).toBe('catalogue')
  })

  it('keeps listing models when the attachment resolver throws', async () => {
    const diagnostics: string[] = []
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'vision', supportsImages: true }] },
    })))
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      resolveAttachments: () => { throw new Error('service store is closed') },
      onDiagnostic: message => { diagnostics.push(message) },
    })
    await adapter.refresh('codebuddy')
    expect((await adapter.listModels('codebuddy'))[0]?.inputModalities).toEqual(['text'])
    expect((await adapter.resolveModel('codebuddy', 'vision')).inputModalities).toEqual(['text'])
    expect(adapter.models('codebuddy')[0]?.inputModalities).toEqual(['text'])
    expect(diagnostics.some(message => message.includes('service store is closed'))).toBe(true)
  })

  it('looks the attachment service up once per listing', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      data: {
        models: [
          { id: 'a', supportsImages: true },
          { id: 'b', supportsImages: true },
          { id: 'c', supportsImages: true },
          { id: 'd', supportsImages: true },
        ],
      },
    })))
    let calls = 0
    const adapter = new CodeBuddyAdapter({
      store: () => storeOf(freshRecord),
      resolveAttachments: () => { calls += 1; return { async readImageRequest() { return { data: new Uint8Array(), mediaType: 'image/png' } } } },
    })
    await adapter.refresh('codebuddy')
    calls = 0
    await adapter.listModels('codebuddy')
    expect(calls).toBe(1)
    calls = 0
    adapter.models('codebuddy')
    expect(calls).toBe(1)
  })

  it('projects image request targets the same way the payload does', () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    const ref = { attachmentId: 'sha256:aa', mediaType: 'image/png', bytes: 10, width: 100, height: 50 }
    expect(adapter.imageRequestTarget('codebuddy', 'chat-a', ref as never))
      .toEqual({ width: 100, height: 50, maxImageBytes: 1024 * 1024, imageTargetBytes: 1024 * 1024 })
  })

  it('never projects a malformed size to an unreadable thumbnail', () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    const ref = { attachmentId: 'sha256:aa', mediaType: 'image/png', bytes: 10, width: 0, height: 0 }
    const target = adapter.imageRequestTarget('codebuddy', 'chat-a', ref as never)
    // A 1x1 request image would be encoded and sent without any diagnosis;
    // asking for the full budget keeps the image usable instead.
    expect(target.width).toBeGreaterThan(1)
    expect(target.height).toBeGreaterThan(1)
    expect(target.width * target.height).toBeLessThanOrEqual(2048 * 2048)
  })

  it('streams a chat call through the stored credential', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + '\n\n'))
          controller.close()
        },
      }), { status: 200 })
    })
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord) })
    const chunks = await drain(adapter.stream(optionsOf({})))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(bodies[0]).toMatchObject({ model: 'chat-a', stream: true })
    expect(bodies[0]).not.toHaveProperty('store')
  })

  it('sends the configured system prompt through the adapter', async () => {
    const bodies: { messages?: { role: string; content: unknown }[] }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + '\n\n'))
          controller.close()
        },
      }), { status: 200 })
    })
    let prompt = 'Custom prompt.'
    const adapter = new CodeBuddyAdapter({ store: () => storeOf(freshRecord), systemPrompt: () => prompt })
    await drain(adapter.stream(optionsOf({ system: 'Harness prompt.' })))
    expect(bodies[0]?.messages?.[0]).toEqual({ role: 'system', content: 'Custom prompt.' })
    // A live settings edit reaches the next request without rebuilding the adapter.
    prompt = 'Edited prompt.'
    await drain(adapter.stream(optionsOf({ system: 'Harness prompt.' })))
    expect(bodies[1]?.messages?.[0]).toEqual({ role: 'system', content: 'Edited prompt.' })
  })

  it('refuses to stream without a credential', async () => {
    const adapter = new CodeBuddyAdapter({ store: () => storeOf() })
    await expect(drain(adapter.stream(optionsOf({})))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('errors when no credential service is mounted at all', async () => {
    const adapter = new CodeBuddyAdapter({ store: () => undefined })
    await expect(drain(adapter.stream(optionsOf({})))).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })
})

describe('codebuddy credential addressing', () => {
  it('names the record after the owning plugin and the route', () => {
    expect(credentialKeyFor(cnProfile)).toBe('codebuddy/codebuddy')
    expect(credentialKeyFor({ ...cnProfile, id: 'codebuddy-en' })).toBe('codebuddy/codebuddy-en')
  })
})
