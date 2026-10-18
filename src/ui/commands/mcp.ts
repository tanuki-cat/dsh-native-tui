/**
 * `/mcp`: list, add, and remove MCP servers in the `mcp-manager` namespace.
 *
 * @module dsh-native-tui/ui/commands/mcp
 */

import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { McpManagerStatus, SettingsService } from './services.js'
import { NL, errorMessage } from './shared.js'

/** The `/mcp` command. */
export async function mcpCommand(ctx: CommandContext, args: string): Promise<void> {
  const settings = ctx.host.get('settings') as unknown as SettingsService | undefined
  if (settings === undefined) {
    ctx.notice('warning', 'The settings service is unavailable in this profile.')
    return
  }
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'mcp-manager')
  if (descriptor === undefined) {
    ctx.notice('warning', 'The MCP manager is unavailable; enable the dsh-mcp-client integration first.')
    return
  }
  const rawServers = descriptor.value.servers
  const servers: Record<string, Record<string, unknown>> = rawServers !== null && typeof rawServers === 'object' && !Array.isArray(rawServers)
    ? rawServers as Record<string, Record<string, unknown>>
    : {}
  const mcpStatus = ctx.host.get('mcpManagerStatus') as McpManagerStatus | undefined
  const runtime = mcpStatus?.snapshot() ?? {}

  if (args === '' || args === 'list') {
    const entries = Object.entries(servers)
    if (entries.length === 0) {
      ctx.notice('info', 'No MCP servers configured. Use /mcp add.')
      return
    }
    const rows = entries.map(([name, raw]) => {
      const transport = typeof raw.transport === 'string' ? raw.transport : 'unknown'
      const target = transport === 'stdio'
        ? [typeof raw.command === 'string' ? raw.command : '', ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].filter(Boolean).join(' ')
        : typeof raw.url === 'string' ? raw.url : ''
      const state = runtime[name]
      const palette = ctx.palette
      const status = state === undefined
        ? palette.dim('not loaded')
        : state.status === 'connected' ? palette.success('connected')
          : state.status === 'error' ? palette.error('error: ' + (state.error ?? 'unknown').slice(0, 120))
            : state.status === 'disconnected' ? palette.error('disconnected: ' + (state.error ?? 'unknown').slice(0, 110))
              : palette.warning('starting')
      const targetText = target.length > 72 ? target.slice(0, 69) + '...' : target
      return name + '  ' + transport + (targetText === '' ? '' : '  ' + targetText) + '  ' + status
    })
    ctx.notice('info', 'MCP servers:' + NL + rows.join(NL) + NL + 'Use /mcp add or /mcp remove <name>.')
    return
  }

  if (args === 'add') {
    await addServer(ctx, settings, servers, descriptor.revision)
    return
  }

  if (args.startsWith('remove ')) {
    const name = args.slice('remove '.length).trim()
    if (name === '' || !Object.hasOwn(servers, name)) {
      ctx.notice('warning', 'No configured MCP server "' + name + '".')
      return
    }
    const confirmed = await showChoice(ctx.tui, ctx.palette, 'Remove MCP server ' + name + '?', [
      { value: 'yes', label: 'Remove', description: 'Remove this server from mcp-manager settings' },
      { value: 'no', label: 'Cancel' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (confirmed !== 'yes')
      return
    try {
      await settings.mutate('mcp-manager', [{ op: 'unset', path: ['servers', name] }], descriptor.revision)
      ctx.notice('info', 'MCP server removed: ' + name + '. Its client row is unloaded.')
    }
    catch (error) {
      ctx.notice('error', 'Could not remove MCP server: ' + errorMessage(error))
    }
    return
  }

  ctx.notice('warning', 'Usage: /mcp [add | list | remove <name>]')
}

/** Walk the interactive `/mcp add` flow and write the server row. */
async function addServer(
  ctx: CommandContext,
  settings: SettingsService,
  servers: Record<string, Record<string, unknown>>,
  revision: number,
): Promise<void> {
  const name = await showTextInput(ctx.tui, ctx.palette, 'MCP server name', 'github', '[A-Za-z0-9_-]{1,32}; unique · Esc cancels', ctx.signal)
  if (name === undefined)
    return
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
    ctx.notice('warning', 'MCP server name must match [A-Za-z0-9_-]{1,32}.')
    return
  }
  if (Object.hasOwn(servers, name)) {
    const confirmed = await showChoice(ctx.tui, ctx.palette, 'MCP server ' + name + ' already exists', [
      { value: 'replace', label: 'Replace', description: 'Overwrite this server configuration' },
      { value: 'cancel', label: 'Cancel' },
    ], 'Enter selects · Esc cancels', ctx.signal)
    if (confirmed !== 'replace')
      return
  }
  const transport = await showChoice(ctx.tui, ctx.palette, 'MCP transport', [
    { value: 'stdio', label: 'stdio', description: 'Spawn a local MCP server process' },
    { value: 'streamable-http', label: 'Streamable HTTP', description: 'Connect to an HTTP MCP endpoint' },
  ], 'Enter selects · Esc cancels', ctx.signal)
  if (transport === undefined)
    return
  let config: Record<string, unknown>
  if (transport === 'stdio') {
    const command = await showTextInput(ctx.tui, ctx.palette, 'MCP command', 'npx', 'Executable without shell interpolation · Esc cancels', ctx.signal)
    if (command === undefined)
      return
    if (command.trim() === '') {
      ctx.notice('warning', 'MCP command must not be empty.')
      return
    }
    const argsRaw = await showTextInput(ctx.tui, ctx.palette, 'MCP arguments', '[]', 'Space-separated, or a JSON string array; empty uses no arguments · Esc cancels', ctx.signal, undefined, true)
    if (argsRaw === undefined)
      return
    let argsValue: string[] = []
    if (argsRaw.trim() !== '') {
      try {
        const parsed = argsRaw.trim().startsWith('[') ? JSON.parse(argsRaw) : argsRaw.trim().split(/\s+/u)
        if (!Array.isArray(parsed) || parsed.some((value: unknown) => typeof value !== 'string'))
          throw new Error('arguments must be strings')
        argsValue = parsed as string[]
      }
      catch (error) {
        ctx.notice('error', 'Invalid MCP arguments: ' + errorMessage(error))
        return
      }
    }
    const envRaw = await showTextInput(ctx.tui, ctx.palette, 'MCP environment JSON', '{}', 'Optional JSON object; empty merges nothing over the scrubbed environment · Esc cancels', ctx.signal, undefined, true)
    if (envRaw === undefined)
      return
    ctx.notice('info', 'Applying MCP server ' + name + '…')
    let envValue: Record<string, unknown> | undefined
    if (envRaw.trim() !== '' && envRaw.trim() !== '{}') {
      try {
        const parsed: unknown = JSON.parse(envRaw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('environment must be a JSON object')
        if (Object.values(parsed).some(value => typeof value !== 'string'))
          throw new Error('environment values must be strings')
        envValue = parsed as Record<string, unknown>
      }
      catch (error) {
        ctx.notice('error', 'Invalid MCP environment: ' + errorMessage(error))
        return
      }
    }
    config = {
      transport,
      serverName: name,
      command,
      args: argsValue,
      ...(envValue === undefined ? {} : { env: envValue }),
    }
  }
  else {
    const url = await showTextInput(ctx.tui, ctx.palette, 'MCP endpoint URL', 'http://localhost:3000/mcp', 'Streamable HTTP endpoint · Esc cancels', ctx.signal)
    if (url === undefined)
      return
    const headersRaw = await showTextInput(ctx.tui, ctx.palette, 'MCP headers JSON', '{}', 'Optional JSON object of request headers · Esc cancels', ctx.signal, '{}')
    if (headersRaw === undefined)
      return
    ctx.notice('info', 'Applying MCP server ' + name + '…')
    let headersValue: Record<string, unknown> | undefined
    if (headersRaw.trim() !== '' && headersRaw.trim() !== '{}') {
      try {
        const parsed: unknown = JSON.parse(headersRaw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('headers must be a JSON object')
        if (Object.values(parsed).some(value => typeof value !== 'string'))
          throw new Error('header values must be strings')
        headersValue = parsed as Record<string, unknown>
      }
      catch (error) {
        ctx.notice('error', 'Invalid MCP headers: ' + errorMessage(error))
        return
      }
    }
    config = {
      transport,
      serverName: name,
      url,
      ...(headersValue === undefined ? {} : { headers: headersValue }),
    }
  }
  try {
    await settings.update('mcp-manager', { servers: { [name]: config } }, revision)
    ctx.notice('info', 'MCP server saved: ' + name + ' · ' + transport + '. The manager loads it now; /mcp list shows its connection status.')
  }
  catch (error) {
    ctx.notice('error', 'Could not save MCP server: ' + errorMessage(error))
  }
}
