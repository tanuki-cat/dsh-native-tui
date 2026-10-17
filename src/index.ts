import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as TuiConfig } from './config.js'
import { startTerminalApp, type TerminalApp } from './ui/app.js'
import { debug } from './debug.js'

/** Cordis plugin name. */
export const name = 'native-tui'

/** Host services required before the terminal can create and drive an Agent. */
export const inject = [
  'agents',
  'agentPresets',
  'commands',
  'userQuestions',
  'approval',
  'llm',
  'permissionPresets',
  'jobs',
  'subagents',
  'workspaceRegistry',
  'schedule',
  'fileReferences',
  'sessionReferenceResolver',
  'attachments',
  'workspaceChanges',
]

export { Config }

/**
 * Mount the terminal front door. The Host owns agent lifecycle, sessions,
 * persistence, and tools; this plugin only owns one Agent handle and pi-tui.
 * @param ctx - Host plugin context.
 * @param config - Loader configuration.
 */
export async function apply(ctx: Context, config: TuiConfig): Promise<void> {
  debug('apply: start')
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('native-tui: both stdin and stdout must be TTYs; use the headless or web profile for pipes')
  }

  const resolved = resolveConfig(config)
  let app: TerminalApp | undefined
  let exiting = false

  const exit = (code: number): void => {
    if (exiting) return
    exiting = true
    const finish = (): void => { process.exit(code) }
    void ctx.root.fiber.dispose().then(finish, finish)
    setTimeout(finish, 5_000).unref()
  }

  try {
    debug('apply: starting terminal')
    app = await startTerminalApp(ctx, resolved, exit)
    debug('apply: terminal started')
  } catch (error) {
    throw error
  }

  ctx.effect(() => async () => {
    await app?.dispose()
  }, 'native-tui: terminal lifecycle')
}