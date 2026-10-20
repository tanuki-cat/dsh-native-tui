import type { Context } from '@deepseek-ai/cordis'
import { Config, parseResumeArg, resolveConfig, resolveDisplayMode, resolveVolatileValue, type Config as TuiConfig } from './config.js'
import { startTerminalApp, type TerminalApp } from './ui/app.js'
import { ensureLauncher, parseProfileArg } from './runtime/launcher.js'
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

  try {
    const launcher = await ensureLauncher(parseProfileArg(process.argv.slice(2)))
    debug(`launcher: ${launcher.status}${launcher.path === undefined ? '' : ' ' + launcher.path}${launcher.reason === undefined ? '' : ' (' + launcher.reason + ')'}`)
  } catch (error) {
    debug(`launcher: ${error instanceof Error ? error.message : String(error)}`)
  }

  const resume = parseResumeArg(process.argv.slice(2))
  const resolved = resolveConfig(resume === undefined ? config : { ...config, sessionId: resume })
  let app: TerminalApp | undefined
  let exiting = false
  const syncLiveSettings = (): void => {
    const showReasoning = resolveVolatileValue(config.showReasoning) ?? true
    const thinking = resolveDisplayMode(config.thinkingDisplay) ?? (showReasoning ? 'detailed' : 'hidden')
    const runCode = resolveDisplayMode(config.runCodeDisplay) ?? 'detailed'
    resolved.title = resolveVolatileValue(config.title) ?? 'DeepSeek Harness'
    app?.setDisplayModes(thinking, runCode)
    app?.setMaxEntries(resolveVolatileValue(config.maxTranscriptEntries) ?? 2000)
    app?.setTitle(resolved.title)
  }
  ctx.inject(['settings'], (child) => {
    const settings = (child as unknown as { settings: { configure(options: Record<string, unknown>, fiber: unknown): () => void } }).settings
    child.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })
  const offSettings = (ctx as unknown as { on(event: string, callback: (ns: string) => void): () => void })
    .on('settings/document-updated', (ns) => { if (ns === 'native-tui') syncLiveSettings() })
  ctx.effect(() => offSettings)

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
    syncLiveSettings()
    debug('apply: terminal started')
  } catch (error) {
    throw error
  }

  ctx.effect(() => async () => {
    await app?.dispose()
  }, 'native-tui: terminal lifecycle')
}