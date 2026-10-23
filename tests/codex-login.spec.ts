import { describe, expect, it, vi } from 'vitest'
import { loginCodex, type LoginDeps } from '../src/codex/login.js'
import type { AuthorizationLike, AuthorizationPrompt } from '../src/codex/types.js'

interface Notice {
  readonly level: string
  readonly text: string
}

/** A login harness with recording notices and an injectable authorization seam. */
function harness(authorization: AuthorizationLike, overrides: Partial<LoginDeps> = {}) {
  const notices: Notice[] = []
  const opened: string[] = []
  const deps: LoginDeps = {
    authorization,
    openUrl: url => { opened.push(url); return true },
    notice: (level, text) => { notices.push({ level, text }) },
    choose: async () => undefined,
    ask: async () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
  return { deps, notices, opened }
}

/** A flow that offers one oauth method and runs the supplied body. */
function flow(begin: AuthorizationLike['begin'], overrides: { inFlight?: boolean; methods?: { id: string; label: string }[] } = {}): AuthorizationLike {
  return {
    describe: () => ({ inFlight: overrides.inFlight ?? false, methods: overrides.methods ?? [{ id: 'oauth', label: 'OAuth' }] }),
    begin,
    cancel: () => undefined,
  }
}

/** Resolve undefined when the prompt signal aborts. */
function askUntilAbort(): LoginDeps['ask'] {
  return (_message, _placeholder, _secret, signal) => new Promise(resolve => {
    if (signal.aborted) resolve(undefined)
    else signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
}

describe('Codex sign-in driver', () => {
  it('opens an authorization URL once and keeps other links visible', async () => {
    let beginCalled = 0
    const authorization = flow(async request => {
      beginCalled += 1
      request.interaction.notify({ message: 'Open', url: 'https://auth.openai.com/authorize' })
      request.interaction.notify({ message: 'Again', url: 'https://auth.openai.com/authorize' })
      request.interaction.notify({ message: 'Docs', url: 'https://example.com/docs' })
      return { status: 'authorized' }
    })
    const h = harness(authorization)
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'authorized' })
    expect(beginCalled).toBe(1)
    expect(h.opened).toEqual(['https://auth.openai.com/authorize'])
    expect(h.notices.map(notice => notice.text).join('\n')).toContain('https://example.com/docs')
  })

  it('answers the method select from the command argument', async () => {
    const choose = vi.fn(async () => undefined)
    const authorization = flow(async request => {
      const picked = await request.interaction.prompt({
        kind: 'select',
        message: 'Method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      })
      expect(picked).toBe('device_code')
      return { status: 'authorized' }
    })
    const h = harness(authorization, { choose, method: 'device' })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'authorized' })
    expect(choose).not.toHaveBeenCalled()
  })

  it('re-asks after an empty submit instead of cancelling', async () => {
    let calls = 0
    const ask = vi.fn(async () => {
      calls += 1
      return calls === 1 ? '' : 'the-code'
    })
    const authorization = flow(async request => {
      const answer = await request.interaction.prompt({ kind: 'text', message: 'Paste the code' })
      expect(answer).toBe('the-code')
      return { status: 'authorized' }
    })
    const h = harness(authorization, { ask })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'authorized' })
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('treats a withdrawn prompt as the callback winning', async () => {
    const withdraw = new AbortController()
    const authorization = flow(async request => {
      const pending = request.interaction.prompt({ kind: 'text', message: 'Paste', signal: withdraw.signal })
      withdraw.abort()
      await expect(pending).rejects.toThrow('prompt withdrawn')
      return { status: 'authorized' }
    })
    const h = harness(authorization, { ask: askUntilAbort() })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'authorized' })
  })

  it('aborts the attempt when the prompt is cancelled', async () => {
    const authorization = flow(async request => {
      try {
        await request.interaction.prompt({ kind: 'text', message: 'Paste' })
      }
      catch {
        // the surface cancelled the prompt
      }
      return { status: request.signal?.aborted === true ? 'cancelled' : 'authorized' }
    })
    const h = harness(authorization, { ask: async () => undefined })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'cancelled' })
  })

  it('times out an attempt that never settles', async () => {
    const authorization = flow(request => new Promise(resolve => {
      request.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
    }))
    const h = harness(authorization, { timeoutMs: 10 })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'timed-out' })
  })

  it('offers a cancel row while waiting for a device code', async () => {
    const choose = vi.fn(async (title: string, _items: unknown, _hint: string, signal: AbortSignal) => {
      expect(title).toContain('ABCD')
      expect(signal.aborted).toBe(false)
      return 'cancel'
    })
    const authorization = flow(async request => {
      request.interaction.notify({ message: 'Enter the code', url: 'https://auth.openai.com/codex/device', code: 'ABCD' })
      await new Promise<void>(resolve => {
        request.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { status: 'cancelled' }
    })
    const h = harness(authorization, { method: 'device', choose })
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'cancelled' })
    expect(choose).toHaveBeenCalledTimes(1)
  })

  it('refuses a second attempt while one is in flight', async () => {
    const begin = vi.fn()
    const authorization = flow(begin, { inFlight: true })
    const h = harness(authorization)
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'cancelled' })
    expect(begin).not.toHaveBeenCalled()
    expect(h.notices.map(notice => notice.text).join('\n')).toContain('already running')
  })

  it('reports an already-in-flight refusal from the seam', async () => {
    const authorization = flow(async () => {
      throw Object.assign(new Error('busy'), { code: 'ALREADY_IN_FLIGHT' })
    })
    const h = harness(authorization)
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'cancelled' })
    expect(h.notices.map(notice => notice.text).join('\n')).toContain('already running')
  })

  it('warns when no flow is registered', async () => {
    const authorization: AuthorizationLike = {
      describe: () => undefined,
      begin: vi.fn(),
      cancel: () => undefined,
    }
    const h = harness(authorization)
    await expect(loginCodex(h.deps)).resolves.toEqual({ status: 'cancelled' })
    expect(h.notices[0]?.text).toContain('No openai-codex sign-in flow')
  })
})
