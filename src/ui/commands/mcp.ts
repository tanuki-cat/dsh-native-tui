/**
 * `/mcp`: list, add, remove, restart, and probe MCP servers in the `mcp-manager` namespace.
 *
 * @module dsh-native-tui/ui/commands/mcp
 */

import { showChoice, showTextInput } from '../dialogs.js'
import type { CommandContext } from './context.js'
import type { McpManagedServerStatus, McpManagerService, McpProbeResultLike, SettingsService } from './services.js'
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
  const manager = ctx.host.get('mcpManager') as McpManagerService | undefined

  if (args === '' || args === 'list') {
    if (manager === undefined) {
      ctx.notice('warning', 'The core MCP manager is unavailable; this Host does not mount @deepseek-ai/dsh-mcp-manager.')
      return
    }
    const views = manager.list()
    if (views.length === 0) {
      ctx.notice('info', 'No MCP servers configured. Use /mcp add.')
      return
    }
    const rows = views.map(view => {
      const raw = servers[view.name]
      const transport = typeof raw?.transport === 'string' ? raw.transport : view.configured ? 'unknown' : '(not configured)'
      const target = describeTarget(raw)
      return view.name + '  ' + transport + (target === '' ? '' : '  ' + target)
        + '  ' + statusLabel(view.status, ctx.palette)
    })
    ctx.notice('info', 'MCP servers:' + NL + rows.join(NL)
      + NL + 'Use /mcp add, /mcp remove <name>, /mcp reload [name], or /mcp probe <name>.')
    return
  }

  if (args === 'add') {
    await addServer(ctx, settings, servers, descriptor.revision, manager)
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
      ctx.notice('info', 'MCP server removed: ' + name + '. The manager reconciles it.')
    }
    catch (error) {
      ctx.notice('error', 'Could not remove MCP server: ' + errorMessage(error))
    }
    return
  }

  if (args === 'probe' || args.startsWith('probe ')) {
    const name = args.slice('probe'.length).trim()
    if (manager === undefined) {
      ctx.notice('warning', 'The core MCP manager is unavailable; probe needs the rc.2 Host.')
      return
    }
    if (name === '') {
      ctx.notice('warning', 'Usage: /mcp probe <name>')
      return
    }
    if (!manager.list().some(view => view.name === name)) {
      ctx.notice('warning', 'No configured MCP server "' + name + '".')
      return
    }
    ctx.notice('info', 'Probing MCP server ' + name + '…')
    try {
      const result = await manager.probe(name, { signal: ctx.signal })
      ctx.notice(result.ok ? 'info' : 'error', probeSummary(name, result))
      if (result.cleanupError !== undefined) ctx.notice('warning', 'MCP probe cleanup: ' + result.cleanupError)
    }
    catch (error) {
      ctx.notice('error', 'Could not probe MCP server ' + name + ': ' + errorMessage(error))
    }
    return
  }

  if (args === 'reload' || args.startsWith('reload ')) {
    if (manager === undefined) {
      ctx.notice('warning', 'The core MCP manager is unavailable; this Host does not mount @deepseek-ai/dsh-mcp-manager.')
      return
    }
    const name = args.slice('reload'.length).trim()
    const configured = manager.list().filter(view => view.configured).map(view => view.name)
    if (name !== '' && !configured.includes(name)) {
      ctx.notice('warning', 'No configured MCP server "' + name + '".')
      return
    }
    const targets = name === '' ? configured : [name]
    if (targets.length === 0) {
      ctx.notice('info', 'No MCP servers configured. Use /mcp add.')
      return
    }
    ctx.notice('info', 'Restarting MCP ' + (targets.length === 1 ? targets[0] : targets.length + ' servers') + '…')
    for (const target of targets) {
      try {
        await manager.restart(target)
      }
      catch (error) {
        ctx.notice('error', 'Could not restart MCP server ' + target + ': ' + errorMessage(error))
        continue
      }
      const status = manager.list().find(view => view.name === target)?.status
      ctx.notice(status?.state === 'connected' ? 'info' : 'warning',
        'MCP server ' + target + ' restarted: ' + stateDescription(status))
    }
    return
  }

  ctx.notice('warning', 'Usage: /mcp [add | list | reload [name] | probe <name> | remove <name>]')
}

/** Walk the interactive `/mcp add` flow and write the server row. */
async function addServer(
  ctx: CommandContext,
  settings: SettingsService,
  servers: Record<string, Record<string, unknown>>,
  revision: number,
  manager: McpManagerService | undefined,
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
      url,
      ...(headersValue === undefined ? {} : { headers: headersValue }),
    }
  }
  try {
    await settings.update('mcp-manager', { servers: { [name]: config } }, revision)
    ctx.notice('info', 'MCP server saved: ' + name + ' · ' + transport + '. Checking its connection…')
    if (manager === undefined) return
    let status: McpManagedServerStatus | undefined
    try {
      status = await waitForStatus(manager, name, ctx.signal)
    }
    catch {
      // The save is durable; an aborted wait is reported by /mcp list later.
      return
    }
    ctx.notice(status?.state === 'connected' ? 'info' : 'warning',
      'MCP server ' + name + ': ' + stateDescription(status))
  }
  catch (error) {
    ctx.notice('error', 'Could not save MCP server: ' + errorMessage(error))
  }
}

/** Wait for a newly configured server to leave its transient startup states. */
async function waitForStatus(
  manager: McpManagerService,
  name: string,
  signal: AbortSignal,
): Promise<McpManagedServerStatus | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted()
    const status = manager.list().find(view => view.name === name)?.status
    if (status !== undefined && status.state !== 'connecting' && status.state !== 'reconnecting') return status
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return manager.list().find(view => view.name === name)?.status
}

/** Transport target shown in the server list. */
function describeTarget(raw: Record<string, unknown> | undefined): string {
  if (raw === undefined) return ''
  const target = raw.transport === 'stdio'
    ? [typeof raw.command === 'string' ? raw.command : '', ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].filter(Boolean).join(' ')
    : typeof raw.url === 'string' ? raw.url : ''
  return target.length > 72 ? target.slice(0, 69) + '...' : target
}

/** Collapsed connection state with the Host diagnostic. */
function statusLabel(status: McpManagedServerStatus, palette: CommandContext['palette']): string {
  const detail = status.lastError ?? status.result?.cleanupError
  const suffix = detail === undefined ? '' : ': ' + detail.slice(0, 110)
  switch (status.state) {
    case 'connected': return palette.success('connected' + (status.toolCount === undefined ? '' : ' · ' + String(status.toolCount) + ' tools'))
    case 'disabled': return palette.dim('disabled')
    case 'connecting': return palette.warning('connecting')
    case 'reconnecting': return palette.warning('reconnecting' + (status.attempt === undefined ? '' : ' (attempt ' + String(status.attempt) + ')'))
    case 'waiting-credentials': return palette.warning('waiting for credentials')
    case 'closed': return palette.error('closed')
    case 'failed': return palette.error('failed' + (status.reason === undefined ? '' : ' (' + status.reason + ')') + suffix)
  }
}

/** Plain state text for a restart receipt. */
function stateDescription(status: McpManagedServerStatus | undefined): string {
  if (status === undefined) return 'not loaded'
  const reason = status.reason === undefined ? '' : ' (' + status.reason + ')'
  const detail = status.lastError ?? status.result?.cleanupError
  return status.state + reason + (detail === undefined ? '' : ' · ' + detail.slice(0, 160))
}

/** One-line probe receipt. */
function probeSummary(name: string, result: McpProbeResultLike): string {
  if (!result.ok) return 'MCP probe ' + name + ' failed at ' + (result.stage ?? 'unknown') + ': ' + (result.message ?? 'unknown error')
  const identity = result.serverInfo === undefined ? '' : ' · ' + result.serverInfo.name + (result.serverInfo.version === undefined ? '' : ' ' + result.serverInfo.version)
  const tools = String(result.toolNames?.length ?? 0) + ' tool(s)' + (result.truncated === true ? ' (truncated)' : '')
  return 'MCP probe ' + name + ' ok' + identity + ' · ' + tools + (result.durationMs === undefined ? '' : ' · ' + String(result.durationMs) + 'ms')
}
