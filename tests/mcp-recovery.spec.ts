import { describe, expect, it, vi } from 'vitest'
import { installMcpRecovery } from '../src/runtime/mcp-recovery.js'

interface View {
  readonly name: string
  readonly status: { readonly state: string }
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
const connected = (name: string): View => ({ name, status: { state: 'connected' } })

describe('mcp recovery', () => {
  it('restarts a connected server after a connection-class failure', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea')], restart })
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('leaves a server the core manager is already reconnecting', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [{ name: 'idea', status: { state: 'reconnecting' } }], restart })
    h.emit({ name: 'mcp__idea__list' }, failure('Error POSTing to endpoint'))
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
    h.emit({ name: 'mcp__idea__list' }, failure('ECONNRESET'))
    h.emit({ name: 'mcp__idea__list' }, failure('ECONNRESET'))
    await flush()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('matches a server name that itself contains a double underscore', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ list: () => [connected('idea__prod')], restart })
    h.emit({ name: 'mcp__idea__prod__list' }, failure('Connection closed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea__prod')
  })

  it('restarts when the manager cannot list its servers', async () => {
    const restart = vi.fn(async () => undefined)
    const h = harness({ restart })
    h.emit({ name: 'mcp__idea__list' }, failure('Connection closed'))
    await flush()
    expect(restart).toHaveBeenCalledWith('idea')
  })

  it('removes its listener on dispose', () => {
    const h = harness({ restart: vi.fn(async () => undefined) })
    h.dispose()
    expect(() => h.emit({ name: 'mcp__idea__list' }, failure('ECONNRESET'))).not.toThrow()
  })
})
