import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  cnProfile,
  credentialExpiresAt,
  enProfile,
  normalizeEnPayload,
} from '../src/codebuddy/profiles.js'
import { classifyFailure, hintForGatewayError, redact } from '../src/codebuddy/errors.js'
import {
  contextWindowOf,
  discoverModels,
  maxOutputTokensOf,
  parseCatalogue,
  seedCatalogue,
} from '../src/codebuddy/models.js'
import { checkIn, fetchQuota, parseQuota, summarizeAccounts } from '../src/codebuddy/credits.js'

const NEVER = new AbortController().signal
const DAY = 24 * 60 * 60 * 1000

afterEach(() => { vi.unstubAllGlobals() })

describe('codebuddy profiles', () => {
  it('bakes the rotation skew into the stored expiry', () => {
    expect(credentialExpiresAt(7 * DAY / 1000, 0)).toBe(6 * DAY)
    expect(credentialExpiresAt(30 * DAY / 1000, 0)).toBe(15 * DAY)
    expect(credentialExpiresAt(3600, 0)).toBe(30 * 60 * 1000)
    expect(credentialExpiresAt(undefined, 0)).toBe(12 * 60 * 60 * 1000)
  })

  it('keeps the two deployments apart', () => {
    expect(cnProfile.chatBaseUrls[0]).toBe('https://copilot.tencent.com/v2')
    expect(enProfile.chatBaseUrls[0]).toBe('https://www.workbuddy.ai/console')
    expect(enProfile.chatBaseUrls[1]).toBe('https://www.workbuddy.ai/v2')
    expect(cnProfile.headers()).not.toHaveProperty('Authorization')
    expect(cnProfile.headers('token-1').Authorization).toBe('Bearer token-1')
    expect(enProfile.chatExtraHeaders?.Accept).toContain('text/event-stream')
  })

  it('expresses tool_choice none by dropping the declarations', () => {
    const body: Record<string, unknown> = { tool_choice: 'none', tools: [1], functions: [2] }
    normalizeEnPayload(body)
    expect(body).toEqual({})
    const auto: Record<string, unknown> = { tool_choice: 'auto', tools: [1] }
    normalizeEnPayload(auto)
    expect(auto).toEqual({ tool_choice: 'auto', tools: [1] })
  })
})

describe('codebuddy failure classification', () => {
  it('classifies by business code before status', () => {
    expect(classifyFailure(200, JSON.stringify({ code: 11102 }))).toBe('no_such_model')
    expect(classifyFailure(403, JSON.stringify({ code: 11140 }))).toBe('auth')
    expect(classifyFailure(401, '{}')).toBe('auth')
    expect(classifyFailure(402, '')).toBe('quota')
    expect(classifyFailure(429, '')).toBe('rate_limit')
    expect(classifyFailure(500, 'boom')).toBe('unavailable')
    expect(classifyFailure(400, JSON.stringify({ code: 11128 }))).toBe('bad_request')
  })

  it('redacts credential material', () => {
    expect(redact('Bearer abcdefghijklmnop')).toContain('<redacted>')
    expect(redact('{"accessToken":"abcdefgh"}')).not.toContain('abcdefgh')
    expect(redact('state=abcdefgh')).toContain('state=<redacted>')
  })

  it('offers an actionable hint only when one exists', () => {
    expect(hintForGatewayError('{"code":11102,"msg":"gone"}')).toContain('/codebuddy models refresh')
    expect(hintForGatewayError('the model exploded')).toBeUndefined()
    expect(hintForGatewayError(undefined)).toBeUndefined()
  })
})

describe('codebuddy catalogue mapping', () => {
  it('uses the gateway values and falls back conservatively', () => {
    expect(contextWindowOf(5000)).toBe(5000)
    expect(contextWindowOf(500)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowOf('nope')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(maxOutputTokensOf(4096)).toBe(4096)
    expect(maxOutputTokensOf(0)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('filters media models, maps reasoning and deduplicates', () => {
    const body = JSON.stringify({
      code: 0,
      data: {
        models: [
          {
            id: 'chat-a',
            maxInputTokens: 5000,
            maxOutputTokens: 1000,
            supportsReasoning: true,
            reasoning: { supportedEfforts: ['low', 'max'], canDisableThinking: false },
          },
          { id: 'paint', tags: ['text-to-image'] },
          { id: 'chat-a' },
          { id: '' },
        ],
      },
    })
    expect(parseCatalogue(body)).toEqual([
      {
        id: 'chat-a',
        name: 'chat-a',
        contextWindow: 5000,
        maxTokens: 1000,
        reasoningEfforts: ['low', 'max'],
        canDisableThinking: false,
      },
    ])
    expect(parseCatalogue(JSON.stringify({ code: 1, data: { models: [] } }))).toEqual([])
    expect(parseCatalogue('not json')).toEqual([])
  })

  it('offers the seed list before the first discovery', () => {
    const seeds = seedCatalogue(cnProfile)
    expect(seeds.length).toBe(cnProfile.seedModels.length)
    expect(seeds[0]?.id).toBe('deepseek-v4-pro')
  })

  it('reports discovery failures without throwing', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 1 }), { status: 200 }))
    expect((await discoverModels(cnProfile, 'token', NEVER)).error).toBe('catalogue was empty')
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    expect((await discoverModels(cnProfile, 'token', NEVER)).error).toBe('HTTP 401')
    vi.stubGlobal('fetch', async () => { throw new Error('socket closed') })
    expect((await discoverModels(cnProfile, 'token', NEVER)).error).toBe('unreachable: socket closed')
  })
})

describe('codebuddy credits', () => {
  it('sums renewing and one-off packages', () => {
    const summary = summarizeAccounts([
      {
        CycleEndTime: '2026-01-01T00:00:00.000Z',
        DeductionEndTime: Date.parse('2026-01-06T00:00:00.000Z'),
        CycleCapacityRemainPrecise: '7.5',
      },
      { CapacityRemainPrecise: '3.25' },
    ])
    expect(summary.remaining).toBe(10.75)
    expect(summary.packages.map(entry => entry.refill)).toEqual([true, false])
  })

  it('reads the account list out of the response shape', () => {
    const summary = parseQuota({ code: 0, data: { Response: { Data: { Accounts: [{ CapacityRemainPrecise: '3.25' }] } } } })
    expect(summary?.remaining).toBe(3.25)
    expect(parseQuota({ code: 1 })).toBeUndefined()
  })

  it('falls back to the next billing endpoint only on 404/405', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      if (seen.length === 1) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [{ CapacityRemainPrecise: '5' }] } } } }))
    })
    const result = await fetchQuota(enProfile, 'token', NEVER)
    expect(result.ok && result.summary.remaining).toBe(5)
    expect(seen).toEqual(enProfile.usageUrls)
  })

  it('reports an unavailable quota read instead of a fake zero', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ msg: 'boom' }), { status: 500 }))
    const result = await fetchQuota(cnProfile, 'token', NEVER)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('HTTP 500')
  })

  it('treats code 10001 as already claimed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 10001 }), { status: 400 }))
    expect(await checkIn(cnProfile, 'token', NEVER)).toEqual({ status: 'already' })
  })

  it('reports a successful claim', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0, data: { credit: 5, streak_days: 2 } }), { status: 200 }))
    expect(await checkIn(cnProfile, 'token', NEVER)).toEqual({ status: 'checked-in', credit: 5, streakDays: 2 })
  })
})
