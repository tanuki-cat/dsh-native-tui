import { describe, expect, it } from 'vitest'
import { fetchCodexUsage, parseUsageSnapshot } from '../src/codex/usage.js'
import { usageBody } from './codex-fixtures.js'

const NOW = 1_000_000
const ACCOUNT = 'acct-1'
const SIGNAL = new AbortController().signal

/** A fetch double that answers one body with the given media type and status. */
function responseFetcher(body: unknown, options: { status?: number; contentType?: string } = {}) {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, {
      status: options.status ?? 200,
      headers: { 'content-type': options.contentType ?? 'application/json' },
    })
  }
  return { fetcher: fetcher as typeof fetch, calls }
}

/** A fetch double that rejects once the request signal aborts. */
function abortingFetcher(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    if (init?.signal?.aborted === true) abort()
    else init?.signal?.addEventListener('abort', abort, { once: true })
  })) as typeof fetch
}

/** Read one body through the parser. */
function parse(body: unknown, now = NOW) {
  return parseUsageSnapshot(body, now, ACCOUNT)
}

describe('Codex usage snapshot', () => {
  it('reads both windows by their length', () => {
    const result = parse(usageBody())
    expect(result).toEqual({
      kind: 'ok',
      usage: {
        fetchedAt: NOW,
        fiveHour: { usedPercent: 12, remainingPercent: 88, windowSeconds: 18_000, resetsAt: 2_000_000 },
        weekly: { usedPercent: 42, remainingPercent: 58, windowSeconds: 604_800, resetsAt: 5_000_000 },
        allowed: true,
      },
    })
  })

  it('recognises the windows regardless of which slot the service uses', () => {
    const body = usageBody()
    const rate = body.rate_limit
    const swapped = {
      ...body,
      rate_limit: { ...rate, primary_window: rate.secondary_window, secondary_window: rate.primary_window },
    }
    const result = parse(swapped)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHour?.windowSeconds).toBe(18_000)
    expect(result.usage.weekly?.windowSeconds).toBe(604_800)
  })

  it('accepts minute-based window lengths from newer builds', () => {
    const result = parse({
      account_id: ACCOUNT,
      rate_limit: {
        primary_window: { used_percent: 25, window_minutes: 300, reset_at: 2_000 },
        secondary_window: { used_percent: 50, window_minutes: 10_080, reset_at: 3_000 },
      },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHour).toEqual({ usedPercent: 25, remainingPercent: 75, windowSeconds: 18_000, resetsAt: 2_000_000 })
    expect(result.usage.weekly?.windowSeconds).toBe(604_800)
  })

  it('derives the reset instant from the countdown when no timestamp is sent', () => {
    const body = usageBody()
    const rate = body.rate_limit
    const result = parse({
      ...body,
      rate_limit: {
        ...rate,
        primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 60 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 120 },
      },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHour?.resetsAt).toBe(NOW + 60_000)
    expect(result.usage.weekly?.resetsAt).toBe(NOW + 120_000)
  })

  it('explains a window the service did not return without dropping the other', () => {
    const body = usageBody()
    const result = parse({
      ...body,
      rate_limit: { ...body.rate_limit, secondary_window: null },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHour?.remainingPercent).toBe(88)
    expect(result.usage.weekly).toBeUndefined()
    expect(result.usage.weeklyReason).toBe('not-returned')
  })

  it('rejects duplicate windows of the same length', () => {
    const body = usageBody()
    const result = parse({
      ...body,
      rate_limit: { ...body.rate_limit, secondary_window: { ...body.rate_limit.primary_window } },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHour).toBeUndefined()
    expect(result.usage.fiveHourReason).toBe('invalid-response')
    expect(result.usage.weeklyReason).toBe('not-returned')
  })

  it('keeps a valid window when its sibling reports an impossible percentage', () => {
    const body = usageBody({ fiveHourPercent: 140 })
    const result = parse(body)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHourReason).toBe('invalid-response')
    expect(result.usage.weekly?.remainingPercent).toBe(58)
  })

  it('marks a window that already reset as expired', () => {
    const body = usageBody({ resetAtSeconds: NOW / 1000 - 1 })
    const result = parse(body)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHourReason).toBe('expired')
    expect(result.usage.weekly?.remainingPercent).toBe(58)
  })

  it('rejects a body scoped to a different account', () => {
    expect(parse(usageBody({ accountId: 'acct-2' }))).toEqual({ kind: 'unavailable', reason: 'account-changed' })
  })

  it('accepts a body without an account id', () => {
    const result = parse(usageBody({ accountId: null }))
    expect(result.kind).toBe('ok')
  })

  it('reports both windows as missing when the body carries no rate limit', () => {
    const result = parse({ account_id: ACCOUNT })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.usage.fiveHourReason).toBe('not-returned')
    expect(result.usage.weeklyReason).toBe('not-returned')
  })

  it('rejects a body that is not an object', () => {
    expect(parse('nope')).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
    expect(parse({ rate_limit: 'nope' })).toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })
})

describe('Codex usage request', () => {
  it('sends the bearer token, the account id and no redirects', async () => {
    const { fetcher, calls } = responseFetcher(usageBody())
    const result = await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher, now: () => NOW })
    expect(result.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(calls[0]?.init?.headers).toEqual({
      authorization: 'Bearer token',
      'ChatGPT-Account-Id': ACCOUNT,
      accept: 'application/json',
    })
    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('maps rejected credentials, permissions and unknown failures', async () => {
    const cases: Array<readonly [number, string]> = [
      [401, 'credential-expired'],
      [403, 'permission-denied'],
      [429, 'rate-limited'],
      [500, 'network-error'],
    ]
    for (const [status, reason] of cases) {
      const { fetcher } = responseFetcher({}, { status })
      const result = await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher })
      expect(result).toEqual({ kind: 'unavailable', reason })
    }
  })

  it('rejects a response that is not JSON', async () => {
    const html = responseFetcher('<html>nope</html>', { contentType: 'text/html' })
    expect(await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher: html.fetcher }))
      .toEqual({ kind: 'unavailable', reason: 'invalid-response' })

    const broken = responseFetcher('{not json', {})
    expect(await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher: broken.fetcher }))
      .toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('rejects an oversized body', async () => {
    const { fetcher } = responseFetcher('x'.repeat(256 * 1024 + 1))
    expect(await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher }))
      .toEqual({ kind: 'unavailable', reason: 'invalid-response' })
  })

  it('times out a request that never answers', async () => {
    const result = await fetchCodexUsage({
      access: 'token',
      accountId: ACCOUNT,
      signal: SIGNAL,
      fetcher: abortingFetcher(),
      timeoutMs: 5,
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('reports an already cancelled command', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await fetchCodexUsage({
      access: 'token',
      accountId: ACCOUNT,
      signal: controller.signal,
      fetcher: abortingFetcher(),
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'cancelled' })
  })

  it('reports a transport failure', async () => {
    const fetcher = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const result = await fetchCodexUsage({ access: 'token', accountId: ACCOUNT, signal: SIGNAL, fetcher })
    expect(result).toEqual({ kind: 'unavailable', reason: 'network-error' })
  })
})
