import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import { mcpCommand } from '../src/ui/commands/mcp.js'
import { providerCommand } from '../src/ui/commands/provider.js'
import { agentsCommand, jobsCommand } from '../src/ui/commands/runtime-status.js'
import { sessionsCommand } from '../src/ui/commands/sessions.js'
import { formatLocalTimestamp } from '../src/ui/format-time.js'
import { settingsCommand } from '../src/ui/commands/settings.js'
import { scheduleCommand, workspacesCommand } from '../src/ui/commands/workspace.js'

/** One recorded notice. */
interface Notice {
  readonly tone: string
  readonly text: string
}

/**
 * A command context with no Host services unless a case supplies them.
 * The handlers under test here only reach for services they are told about, so
 * an empty registry exercises their refusal paths.
 */
function contextOf(services: Record<string, unknown> = {}): CommandContext & { notices: Notice[] } {
  const notices: Notice[] = []
  const host = {
    get: (name: string) => services[name],
    on: () => () => undefined,
    commands: { list: () => [] },
  }
  return {
    notices,
    host: host as unknown as CommandContext['host'],
    config: { cwd: '/tmp', title: 't', theme: 'auto', fullscreen: false } as unknown as CommandContext['config'],
    palette: {
      dim: (s: string) => s,
      bold: (s: string) => s,
      accent: (s: string) => s,
      brand: (s: string) => s,
      success: (s: string) => s,
      warning: (s: string) => s,
      error: (s: string) => s,
    } as unknown as CommandContext['palette'],
    tui: {} as unknown as CommandContext['tui'],
    active: { id: 'session-1', agent: { session: { snapshotEvents: () => [] } } } as unknown as CommandContext['active'],
    signal: new AbortController().signal,
    notice: (tone, text) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: { current: undefined, assembled: undefined },
    setContextWindow: () => undefined,
    persistSelection: async () => undefined,
  }
}

/** Every notice the handler produced, joined. */
function allText(ctx: { notices: Notice[] }): string {
  return ctx.notices.map(notice => notice.text).join('\n')
}

describe('command handler refusals', () => {
  it('reports the missing settings service once, with no other output', async () => {
    const ctx = contextOf()
    await settingsCommand(ctx, 'host')
    expect(ctx.notices).toHaveLength(1)
    expect(ctx.notices[0]?.text).toBe('The settings service is unavailable in this profile.')
  })

  it('reports the missing LLM catalog for /provider', async () => {
    const ctx = contextOf({ settings: { describe: () => [] } })
    await providerCommand(ctx, 'list')
    expect(allText(ctx)).toContain('The LLM catalog service is unavailable.')
  })

  it('reports the missing MCP manager namespace', async () => {
    const ctx = contextOf({ settings: { describe: () => [] } })
    await mcpCommand(ctx, 'list')
    expect(allText(ctx)).toContain('The MCP manager is unavailable')
  })

  it('reports the missing background-jobs service', () => {
    const ctx = contextOf()
    jobsCommand(ctx, '')
    expect(allText(ctx)).toContain('The background-jobs service is unavailable.')
  })

  it('reports the missing schedule service', async () => {
    const ctx = contextOf()
    await scheduleCommand(ctx, '')
    expect(allText(ctx)).toContain('The schedule service is unavailable.')
  })

  it('reports the missing workspace registry', async () => {
    const ctx = contextOf()
    await workspacesCommand(ctx, '', async () => undefined, () => undefined)
    expect(allText(ctx)).toContain('The workspace registry is unavailable.')
  })
})

describe('command handler argument paths', () => {
  const settings = {
    describe: () => [{ ns: 'mcp-manager', value: { servers: {} }, schema: {}, revision: 1 }],
    update: async () => undefined,
    mutate: async () => undefined,
  }

  it('prints the /mcp remove usage when the name is unknown', async () => {
    const ctx = contextOf({ settings })
    await mcpCommand(ctx, 'remove ghost')
    expect(allText(ctx)).toContain('No configured MCP server "ghost".')
  })

  it('prints the /mcp usage for an unknown subcommand', async () => {
    const ctx = contextOf({ settings })
    await mcpCommand(ctx, 'nonsense')
    expect(allText(ctx)).toContain('Usage: /mcp [add | list | remove <name>]')
  })

  it('lists an empty MCP registry', async () => {
    const ctx = contextOf({ settings })
    await mcpCommand(ctx, '')
    expect(allText(ctx)).toContain('No MCP servers configured. Use /mcp add.')
  })

  it('prints the /schedule add usage for a bad duration', async () => {
    const ctx = contextOf({
      schedule: {
        list: async () => [],
        create: async () => ({ id: 'x', scheduledAt: '' }),
        delete: async () => ({}),
      },
    })
    await scheduleCommand(ctx, 'add zero title')
    expect(allText(ctx)).toContain('Usage: /schedule add <seconds> <title>')
  })

  it('prints the /schedule delete usage when the id is missing', async () => {
    const ctx = contextOf({
      schedule: {
        list: async () => [],
        create: async () => ({ id: 'x', scheduledAt: '' }),
        delete: async () => ({}),
      },
    })
    await scheduleCommand(ctx, 'delete')
    expect(allText(ctx)).toContain('Usage: /schedule delete <id>')
  })

  it('reports an empty reminder list', async () => {
    const ctx = contextOf({ schedule: { list: async () => [] } })
    await scheduleCommand(ctx, '')
    expect(allText(ctx)).toContain('No active reminders for this session.')
  })

  it('lists background jobs through the service', () => {
    const ctx = contextOf({ jobs: { list: () => [], kill: () => 'requested' } })
    jobsCommand(ctx, '')
    expect(allText(ctx)).toContain('No background jobs for this session.')
  })

  it('prints the /jobs kill usage for an empty id', () => {
    const ctx = contextOf({ jobs: { list: () => [], kill: () => 'requested' } })
    jobsCommand(ctx, 'kill ')
    expect(allText(ctx)).toContain('Usage: /jobs kill <job-id>')
  })
})

describe('notice timestamps', () => {
  const createdAt = Date.UTC(2026, 9, 22, 0, 51, 19)

  it('lists stored sessions with the host-local creation time', async () => {
    const ctx = contextOf({
      sessionPersistence: {
        list: async () => [{ header: { id: 'native-tui-1', cwd: '/tmp/work', createdAt } }],
      },
    })
    await sessionsCommand(ctx)
    expect(allText(ctx)).toContain(formatLocalTimestamp(createdAt))
    expect(allText(ctx)).not.toContain('Z')
  })

  it('lists subagents with the host-local dispatch time', async () => {
    const ctx = contextOf({
      subagents: {
        listChildren: async () => [{ id: 'native-tui-child', createdAt, mode: 'continuable', label: 'read app' }],
      },
    })
    await agentsCommand(ctx)
    expect(allText(ctx)).toContain(formatLocalTimestamp(createdAt))
  })

  it('lists background jobs with the host-local dispatch time', () => {
    const ctx = contextOf({
      jobs: {
        list: () => [{ id: 'job-1', status: 'running', kind: 'bash', label: 'build', startedAt: createdAt }],
        kill: () => 'requested',
      },
    })
    jobsCommand(ctx, '')
    expect(allText(ctx)).toContain(formatLocalTimestamp(createdAt))
  })
})

describe('settings command routing', () => {
  const descriptor = {
    ns: 'mcp-manager',
    value: { servers: {} },
    schema: { type: 'object', dict: { servers: { type: 'object' } } },
    revision: 3,
    applies: 'live' as const,
    autoGenerate: true,
    secrets: [],
  }

  it('rejects an unknown edit namespace without opening the editor', async () => {
    const ctx = contextOf({ settings: { describe: () => [descriptor], update: async () => undefined, mutate: async () => undefined } })
    await settingsCommand(ctx, 'edit ghost')
    expect(allText(ctx)).toContain('No active settings namespace "ghost".')
  })

  it('prints the /settings items usage when the field is missing', async () => {
    const ctx = contextOf({ settings: { describe: () => [descriptor], update: async () => undefined, mutate: async () => undefined } })
    await settingsCommand(ctx, 'items mcp-manager')
    expect(allText(ctx)).toContain('Usage: /settings items <namespace> <array-field>')
  })

  it('refuses an undeclared array field', async () => {
    const ctx = contextOf({ settings: { describe: () => [descriptor], update: async () => undefined, mutate: async () => undefined } })
    await settingsCommand(ctx, 'items mcp-manager missing')
    expect(allText(ctx)).toContain('is not declared')
  })

  it('applies a scripted settings patch through update with its revision', async () => {
    const calls: { ns: string; patch: object; revision?: number }[] = []
    const ctx = contextOf({
      settings: {
        describe: () => [descriptor],
        update: async (ns: string, patch: object, revision?: number) => { calls.push({ ns, patch, revision }) },
        mutate: async () => undefined,
      },
    })
    await settingsCommand(ctx, 'set mcp-manager {"servers":{"demo":{}}}')
    expect(calls).toEqual([{ ns: 'mcp-manager', patch: { servers: { demo: {} } }, revision: 3 }])
    expect(allText(ctx)).toContain('Settings updated: mcp-manager')
  })

  it('summarizes namespaces for /settings list', async () => {
    const ctx = contextOf({ settings: { describe: () => [descriptor], update: async () => undefined, mutate: async () => undefined } })
    await settingsCommand(ctx, 'list')
    expect(allText(ctx)).toContain('Host settings namespaces:')
    expect(allText(ctx)).toContain('mcp-manager')
  })

  it('prints usage for an unknown subcommand', async () => {
    const ctx = contextOf({ settings: { describe: () => [descriptor], update: async () => undefined, mutate: async () => undefined } })
    await settingsCommand(ctx, 'nonsense')
    expect(allText(ctx)).toContain('Usage: /settings')
  })
})
