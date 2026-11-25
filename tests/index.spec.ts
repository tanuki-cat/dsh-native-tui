import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TerminalApp } from '../src/ui/app.js'

const { startTerminalApp } = vi.hoisted(() => ({ startTerminalApp: vi.fn() }))

vi.mock('../src/ui/app.js', () => ({ startTerminalApp }))
vi.mock('../src/runtime/launcher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/runtime/launcher.js')>()
  return { ...actual, ensureLauncher: vi.fn(async () => ({ status: 'skipped', reason: 'test' })) }
})

import { apply } from '../src/index.js'
import { clearReloadSession, RESUME_ENV } from '../src/runtime/reload.js'

interface FakeApp {
  setDisplayModes: ReturnType<typeof vi.fn>
  setMaxEntries: ReturnType<typeof vi.fn>
  setImageThumbnails: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  activeSessionId: () => string
  dispose: ReturnType<typeof vi.fn>
}

function fakeApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    setDisplayModes: vi.fn(),
    setMaxEntries: vi.fn(),
    setImageThumbnails: vi.fn(),
    setTitle: vi.fn(),
    activeSessionId: () => 'session-1',
    dispose: vi.fn(async () => undefined),
    ...overrides,
  }
}

function fakeContext(options: { failEffect?: number } = {}) {
  const cleanups: Array<() => unknown> = []
  let effectCalls = 0
  const ctx = {
    inject: vi.fn(),
    effect: vi.fn((run: () => (() => unknown) | Promise<() => unknown>) => {
      effectCalls += 1
      if (effectCalls === options.failEffect) throw new Error('effect registration failed')
      cleanups.push(run() as () => unknown)
      return () => undefined
    }),
    on: vi.fn(() => () => undefined),
    get: vi.fn(() => undefined),
    fiber: {},
    [Context.root]: { fiber: { dispose: vi.fn(async () => undefined) } },
  }
  return { ctx, cleanups }
}

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const argv = process.argv

function restoreTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(stream, 'isTTY')
  else Object.defineProperty(stream, 'isTTY', descriptor)
}

beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.argv = ['node', 'vitest']
  clearReloadSession()
  delete process.env[RESUME_ENV]
  startTerminalApp.mockReset()
})

afterEach(() => {
  restoreTTY(process.stdin, stdinTTY)
  restoreTTY(process.stdout, stdoutTTY)
  process.argv = argv
  vi.clearAllMocks()
})

describe('terminal application lifecycle', () => {
  it('disposes the started terminal when live settings fail', async () => {
    const app = fakeApp({ setDisplayModes: vi.fn(() => { throw new Error('settings failed') }) })
    startTerminalApp.mockResolvedValue(app)
    const { ctx } = fakeContext()
    await expect(apply(ctx as never, {} as never)).rejects.toThrow('settings failed')
    expect(app.dispose).toHaveBeenCalledOnce()
  })

  it('disposes the started terminal when lifecycle registration fails', async () => {
    const app = fakeApp()
    startTerminalApp.mockResolvedValue(app)
    // The two pre-terminal effects register first; the lifecycle one is third.
    const { ctx } = fakeContext({ failEffect: 3 })
    await expect(apply(ctx as never, {} as never)).rejects.toThrow('effect registration failed')
    expect(app.dispose).toHaveBeenCalledOnce()
  })

  it('leaves disposal to the registered lifecycle effect after a successful start', async () => {
    const app = fakeApp()
    startTerminalApp.mockResolvedValue(app)
    const { ctx, cleanups } = fakeContext()
    await apply(ctx as never, {} as never)
    expect(app.dispose).not.toHaveBeenCalled()
    for (const cleanup of cleanups) await cleanup()
    expect(app.dispose).toHaveBeenCalledOnce()
  })

  it('passes the started terminal to the plugin context', async () => {
    const app = fakeApp()
    startTerminalApp.mockResolvedValue(app as unknown as TerminalApp)
    const { ctx } = fakeContext()
    await apply(ctx as never, {} as never)
    expect(startTerminalApp).toHaveBeenCalledWith(ctx, expect.objectContaining({ sessionId: undefined }), expect.any(Function))
  })
})
