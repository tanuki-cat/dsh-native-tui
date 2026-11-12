/** Terminal-safe diagnostic output for one Host plugin operation. */
import { randomUUID } from 'node:crypto'
import type { PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager'
import { sanitizeTerminalText } from '../../runtime/terminal-text.js'
import type { CommandContext } from './context.js'
import type { PluginChangeResult, PluginManagerService } from './services.js'

/** Keep the Host's failure stage, original diagnostic and log location together. */
export function pluginChangeSuffix(result: PluginChangeResult): string {
  const lines = [' · ' + result.application + (result.application === 'restart-required' ? ' · run /reload to apply' : '')]
  if (result.stage !== undefined) lines.push('stage: ' + result.stage)
  if (result.error !== undefined) lines.push(result.error.code + (result.error.diagnostic === undefined ? '' : ': ' + result.error.diagnostic))
  const run = result.packageResult
  if (run !== undefined) {
    lines.push('package exit: ' + String(run.exitCode) + (run.timedOut ? ' (timed out)' : ''))
    if (run.output.trim() !== '') lines.push(run.output)
    if (run.truncated) lines.push('[Output truncated by Host; see the complete log.]')
    if (run.logPath !== undefined) lines.push('Full log: ' + run.logPath)
    const unmet = (run as { readonly unmet?: unknown }).unmet
    if (typeof unmet === 'string') lines.push('unmet: ' + unmet)
  }
  return sanitizeTerminalText(lines.join('\n'))
}
/** Correlate streaming diagnostics to this invocation and release every listener after settlement. */
export async function withPluginProgress<T>(
  ctx: CommandContext,
  manager: PluginManagerService,
  run: (requestId: PluginInstallRequestId) => Promise<T>,
): Promise<T> {
  const requestId = randomUUID() as PluginInstallRequestId
  const active = (): boolean => !ctx.signal.aborted && ctx.isCurrent?.() !== false
  const disposers = [
    ctx.host.on('plugin-manager/install-state', progress => {
      if (progress.requestId === requestId && active()) ctx.notice('info', 'Plugin installation: ' + progress.phase)
    }),
    ctx.host.on('plugin-manager/install-log', chunk => {
      if (chunk.requestId === requestId && active() && chunk.text.trim() !== '') {
        ctx.notice('info', sanitizeTerminalText(chunk.text))
      }
    }),
    ctx.host.on('plugin-manager/update-state', progress => {
      if (progress.requestId === requestId && active()) ctx.notice('info', 'Plugin update: ' + progress.step)
    }),
  ]
  const cancel = (): void => { void manager.cancelInstall(requestId).catch(() => { /* The owning operation still reports its final result. */ }) }
  ctx.signal.addEventListener('abort', cancel, { once: true })
  try {
    ctx.signal.throwIfAborted()
    return await run(requestId)
  } finally {
    ctx.signal.removeEventListener('abort', cancel)
    for (const dispose of disposers) dispose()
  }
}
