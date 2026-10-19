import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  accessToken,
  credentialKeyFor,
  grantOf,
  login,
  refreshGrant,
  toGrant,
  type CodeBuddyGrant,
  type CredentialRecordLike,
  type CredentialStoreLike,
} from '../src/codebuddy/auth.js'
import { CodeBuddyAdapter } from '../src/codebuddy/adapter.js'
import { cnProfile } from '../src/codebuddy/profiles.js'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

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
      .toEqual({ width: 100, height: 50, maxBytes: 1024 * 1024 })
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
