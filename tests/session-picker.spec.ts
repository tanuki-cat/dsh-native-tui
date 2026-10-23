import { expect, it, onTestFinished } from 'vitest'
import { pickStoredSession } from '../src/ui/commands/sessions.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { createPalette } from '../src/ui/theme.js'

it('offers native root sessions without replacing the composer or showing archived sessions', async () => {
  const controller = new AbortController()
  let dialog: { render(width: number): string[]; handleInput(data: string): void } | undefined
  let ready!: () => void
  const shown = new Promise<void>(resolve => { ready = resolve })
  const ctx = {
    host: { get: (name: string) => name === 'workspaceRegistry'
      ? { archivedSessionIds: ['native-tui-archived'] }
      : { list: async () => [
        { header: { id: 'native-tui-a', cwd: '/a', createdAt: 1 } },
        { header: { id: 'native-tui-b', cwd: '/b', createdAt: 2 } },
        { header: { id: 'native-tui-archived', createdAt: 3 } },
        { header: { id: 'native-tui-child', origin: 'subagent', createdAt: 4 } },
        { header: { id: 'web-session', createdAt: 5 } },
      ] } },
    active: { id: 'native-tui-a' }, signal: controller.signal, palette: createPalette('plain'),
    tui: { showOverlay: (component: NonNullable<typeof dialog>) => {
      dialog = component; ready(); return { hide: () => {} }
    } },
    notice: () => { throw new Error('unexpected notice') },
  } as unknown as CommandContext
  const run = pickStoredSession(ctx)
  onTestFinished(async () => { controller.abort(); await run })
  await shown
  const text = dialog!.render(120).join('\n')
  expect(text).toContain('native-tui-a')
  expect(text).toContain('native-tui-b')
  expect(text).not.toContain('native-tui-archived')
  expect(text).not.toContain('native-tui-child')
  expect(text).not.toContain('web-session')
  dialog!.handleInput('\x1b[B')
  dialog!.handleInput('\r')
  expect(await run).toBe('native-tui-b')
})
