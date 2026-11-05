import type { CommandContext } from '../src/ui/commands/context.js'
import { createPalette } from '../src/ui/theme.js'

/** A scoped bus and command context with no real terminal, storage, or profile writes. */
export function commandFixture(services: Record<string, unknown> = {}) {
  const notices: { tone: string; text: string }[] = []
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const abort = new AbortController()
  const ctx = {
    host: {
      get: (key: string) => services[key],
      on: (event: string, listener: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(listener); handlers.set(event, set)
        return () => { set.delete(listener) }
      },
    },
    active: { id: 'session-1' }, signal: abort.signal, palette: createPalette('plain'), tui: {},
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    isCurrent: () => true,
  } as unknown as CommandContext
  return { ctx, abort, notices, text: () => notices.map(row => row.text).join('\n'),
    emit: (event: string, payload: unknown) => { for (const listener of handlers.get(event) ?? []) listener(payload) },
    listenerCount: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  }
}
