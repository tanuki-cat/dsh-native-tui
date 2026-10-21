import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** How one optional transcript block is rendered. */
export type DisplayMode = 'hidden' | 'compact' | 'detailed'
/** Terminal palette selection. */
export type Theme = 'auto' | 'dark' | 'light' | 'plain'

/** Display mode value in direct config or Loader volatile form. */
type DisplayConfig = DisplayMode | Volatile<DisplayMode>

/**
 * Terminal presentation and startup configuration.
 *
 * Fields marked volatile are live settings: the Loader can rewrite them in the
 * profile patch without remounting the terminal. The runtime still decides
 * when a change applies (a fresh session, a restart, or immediately), which is
 * why `cwd`, `sessionId`, and `agentPreset` are volatile even though the
 * terminal can only honour them on the next launch.
 */
export interface Config {
  /** Open an existing persisted session instead of creating a new one. */
  sessionId?: string | Volatile<string>
  /** Working directory used when creating a session. Defaults to process.cwd(). */
  cwd?: string | Volatile<string>
  /** Legacy boolean: false hides reasoning unless thinkingDisplay is explicitly set. */
  showReasoning?: boolean | Volatile<boolean>
  /** Reasoning/thinking block rendering: hidden, compact one-line preview, or detailed. */
  thinkingDisplay?: DisplayConfig
  /** Code-execution tool (run_code/bash/pwsh) block rendering: hidden, compact summary, or detailed arguments/result. */
  runCodeDisplay?: DisplayConfig
  /** Maximum transcript entries retained in the terminal view. */
  maxTranscriptEntries?: number | Volatile<number>
  /** Use the alternate screen with application-owned scrolling and mouse support. */
  fullscreen?: boolean | Volatile<boolean>
  /** ANSI palette selection. */
  theme?: Theme | Volatile<Theme>
  /** Agent preset used for new sessions; defaults to the registry's configured default. */
  agentPreset?: string | Volatile<string>
  /** Product title shown in the header. */
  title?: string | Volatile<string>
}

/** Fully defaulted configuration used by the terminal runtime. */
export interface ResolvedConfig {
  sessionId: string | undefined
  cwd: string
  showReasoning: boolean
  thinkingDisplay: DisplayMode
  runCodeDisplay: DisplayMode
  maxTranscriptEntries: number
  fullscreen: boolean
  theme: Theme
  agentPreset: string | undefined
  title: string
}

/**
 * Read the app-level `--resume <session-id>` option from process arguments.
 * The launcher passes arguments after its own flags through to the profile app.
 * @param argv - process arguments, including the launcher and profile flags.
 * @returns the requested session id, or undefined when absent.
 */
export function parseResumeArg(argv: readonly string[]): string | undefined {
  let resume: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--resume') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new Error('native-tui: --resume requires a session id')
      }
      resume = value
      index += 1
    }
    else if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length)
      if (value === '') throw new Error('native-tui: --resume requires a session id')
      resume = value
    }
  }
  return resume
}

/** Loader schema for the native-tui row. */
export const Config = z.object({
  sessionId: z.string()
    .description('Resume this persisted session on the next launch instead of creating a new one. Empty starts a new session.')
    .volatile(),
  cwd: z.string()
    .description('Working directory for a new session and relative file commands. Applies to the next launch.')
    .volatile(),
  showReasoning: z.boolean().default(true)
    .description('Legacy switch used only while Thinking display is unset. Prefer the Thinking display setting.')
    .volatile(),
  thinkingDisplay: z.union(['hidden', 'compact', 'detailed'] as const)
    .description('How reasoning blocks render: hidden, a one-line preview, or the full block.')
    .volatile(),
  runCodeDisplay: z.union(['hidden', 'compact', 'detailed'] as const)
    .description('How run_code/bash/pwsh calls render: hidden, a summary, or full arguments and output.')
    .volatile(),
  maxTranscriptEntries: z.number().step(1).min(50).default(600)
    .description('Maximum transcript entries kept in the terminal view. Applies immediately.')
    .volatile(),
  fullscreen: z.boolean().default(false)
    .description('Use the alternate screen with application-owned scrolling. Applies after a restart.')
    .volatile(),
  theme: z.union(['auto', 'dark', 'light', 'plain'] as const).default('auto')
    .description('Terminal palette: auto, dark, light, or plain (no ANSI styling). Applies after a restart.')
    .volatile(),
  agentPreset: z.string()
    .description('Agent preset used for a new session. The registry default stands in while unset; applies to the next launch.')
    .volatile(),
  title: z.string().default('DeepSeek Harness')
    .description('Product title shown in the terminal header. Applies immediately.')
    .volatile(),
})

/**
 * Apply defaults for direct callers that bypass Loader schema resolution.
 * @param config - deployment configuration.
 * @returns complete runtime configuration.
 */
export function resolveDisplayMode(value: DisplayConfig | undefined): DisplayMode | undefined {
  return resolveVolatileValue(value)
}

/** Unwrap a plain config value or Loader volatile reference. */
export function resolveVolatileValue<T>(value: T | Volatile<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && 'get' in value) return value.get() as T | undefined
  return value as T | undefined
}

export function resolveConfig(config: Config | undefined): ResolvedConfig {
  const showReasoning = resolveVolatileValue(config?.showReasoning) ?? true
  return {
    sessionId: resolveVolatileValue(config?.sessionId),
    cwd: resolveVolatileValue(config?.cwd) ?? process.cwd(),
    showReasoning,
    thinkingDisplay: resolveDisplayMode(config?.thinkingDisplay) ?? (showReasoning ? 'detailed' : 'hidden'),
    runCodeDisplay: resolveDisplayMode(config?.runCodeDisplay) ?? 'detailed',
    maxTranscriptEntries: resolveVolatileValue(config?.maxTranscriptEntries) ?? 600,
    fullscreen: resolveVolatileValue(config?.fullscreen) ?? false,
    theme: resolveVolatileValue(config?.theme) ?? 'auto',
    agentPreset: resolveVolatileValue(config?.agentPreset),
    title: resolveVolatileValue(config?.title) ?? 'DeepSeek Harness',
  }
}