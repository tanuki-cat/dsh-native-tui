import { describe, expect, it, vi } from 'vitest'
import { installMcpRecovery, RETRY_WINDOW_MS } from '../src/runtime/mcp-recovery.js'

interface View {
  readonly name: string
  readonly status: { readonly state: string }
  readonly authorization?: { readonly phase: string }
}

function harness(manager: {
  list?: () => readonly View[]
  restart: (name: string) => Promise<void>
}) {
  let handler: ((exec: unknown, result: unknown) => void) | undefined
  const ctx = {
    get: (name: string) => name === 'mcpManager' ? manager : undefined,
    on: (event: string, callback: (exec: unknown, result: unknown) => void) => {
      if (event === 'tools/result') handler = callback
      return () => { handler = undefined }
    },
  } as never
  const dispose = installMcpRecovery(ctx)
  return {
    emit: (exec: unknown, result: unknown) => handler?.(exec, result),
    dispose,
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const failure = (message: string): unknown => ({ isError: true, error: { message } })
const codedFailure = (code: string): unknown => ({ isError: true, error: { message: 'closed', info: { code } } })
const connected = (name: string): View => ({ name, status: { state: 'connected' } })

describe('mcp recovery', () => {
  it.each([
    { state: 'waiting-authorization' },
    { state: 'failed', authorization: { phase: 'committing' } },
  ])('leaves authorization to the manager with %j', async ({ state, authorization }) => {
    const restart = vi.fn(async () => {})
    const h = harness({ list: () => [{ name: 'idea', status: { state }, authorization }], restart })
    h.emit({ name: 'mcp__idea__list' }, codedFailure('ConnectionClosed'))
    await Promise.resolve()
    expect(restart).not.toHaveBeenCalled()
    h.dispose()
  })
  it('restarts a connected server after a run of connection-class failures', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea')], restart })
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).not.toHaveBeenCalled()
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('does not restart a healthy server on one tool-level network error', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('fetch')], restart })
    h.emit({ name: 'mcp__fetch__get' }, failure('fetch failed'))
    await flush()
    expect(restart).not.toHaveBeenCalled()
  })

  it('clears a failure run when the same server answers a call', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('fetch')], restart })
    h.emit({ name: 'mcp__fetch__get' }, failure('fetch failed'))
    h.emit({ name: 'mcp__fetch__get' }, { isError: false })
    h.emit({ name: 'mcp__fetch__get' }, failure('fetch failed'))
    await flush()
    expect(restart).not.toHaveBeenCalled()
  })

  it('restarts at once on the structured closed-connection code', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea')], restart })
    h.emit({ name: 'mcp__idea__list' }, codedFailure('ConnectionClosed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('leaves a server the core manager is already reconnecting', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [{ name: 'idea', status: { state: 'reconnecting' } }], restart })
    for (let attempt = 0; attempt < 3; attempt += 1) h.emit({ name: 'mcp__idea__list' }, failure('Error POSTing to endpoint'))
    await flush()
    expect(restart).not.toHaveBeenCalled()
  })

  it('ignores business failures and non-MCP tools', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea')], restart })
    h.emit({ name: 'mcp__idea__list' }, failure('not found'))
    h.emit({ name: 'read' }, failure('Connection closed'))
    h.emit({ name: 'mcp__idea__list' }, { isError: false })
    await flush()
    expect(restart).not.toHaveBeenCalled()
  })

  it('restarts one server at most once per window', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea')], restart })
    for (let attempt = 0; attempt < 4; attempt += 1) h.emit({ name: 'mcp__idea__list' }, failure('ECONNRESET'))
    await flush()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('does not add up failures separated by more than one retry window', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('fetch')], restart })
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000)
      h.emit({ name: 'mcp__fetch__get' }, failure('ECONNRESET'))
      // Exactly one retry window later, the earlier failure no longer counts.
      now.mockReturnValue(1_000 + RETRY_WINDOW_MS)
      h.emit({ name: 'mcp__fetch__get' }, failure('ECONNRESET'))
      await flush()
      expect(restart).not.toHaveBeenCalled()
      h.emit({ name: 'mcp__fetch__get' }, failure('ECONNRESET'))
      await flush()
      expect(restart).toHaveBeenCalledWith('fetch')
    }
    finally {
      now.mockRestore()
    }
  })

  it('starts a fresh streak after the core manager reconnected on its own', async () => {
    let state = 'connected'
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [{ name: 'idea', status: { state } }], restart })
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    state = 'reconnecting'
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    state = 'connected'
    // The failure the core took over must not finish a fresh streak.
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).not.toHaveBeenCalled()
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('matches a server name that itself contains a double underscore', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea__prod')], restart })
    h.emit({ name: 'mcp__idea__prod__list' }, codedFailure('ConnectionClosed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea__prod')
  })

  it('restarts when the manager cannot list its servers', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ restart })
    h.emit({ name: 'mcp__idea__list' }, codedFailure('ConnectionClosed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('removes its listener on dispose', () => {
    const h = harness({ restart: vi.fn(async () => undefined) })
    h.dispose()
    expect(() => h.emit({ name: 'mcp__idea__list' }, failure('ECONNRESET'))).not.toThrow()
  })
})
