import z from '@deepseek-ai/schemastery'

/** Terminal presentation and startup configuration. */
export interface Config {
  /** Open an existing persisted session instead of creating a new one. */
  sessionId?: string
  /** Working directory used when creating a session. Defaults to process.cwd(). */
  cwd?: string
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Maximum transcript entries retained in the terminal view. */
  maxTranscriptEntries?: number
  /** Use the alternate screen with application-owned scrolling and mouse support. */
  fullscreen?: boolean
  /** ANSI palette selection. */
  theme?: 'auto' | 'dark' | 'light' | 'plain'
  /** Agent preset used for new sessions; defaults to the registry's configured default. */
  agentPreset?: string
  /** Product title shown in the header. */
  title?: string
}

/** Fully defaulted configuration used by the terminal runtime. */
export interface ResolvedConfig {
  sessionId: string | undefined
  cwd: string
  showReasoning: boolean
  maxTranscriptEntries: number
  fullscreen: boolean
  theme: 'auto' | 'dark' | 'light' | 'plain'
  agentPreset: string | undefined
  title: string
}

/** Loader schema for the native-tui row. */
export const Config = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  showReasoning: z.boolean().default(true),
  maxTranscriptEntries: z.number().step(1).min(50).default(2000),
  fullscreen: z.boolean().default(false),
  theme: z.union(['auto', 'dark', 'light', 'plain'] as const).default('auto'),
  agentPreset: z.string(),
  title: z.string().default('DeepSeek Harness'),
})

/**
 * Apply defaults for direct callers that bypass Loader schema resolution.
 * @param config - deployment configuration.
 * @returns complete runtime configuration.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  return {
    sessionId: config?.sessionId,
    cwd: config?.cwd ?? process.cwd(),
    showReasoning: config?.showReasoning ?? true,
    maxTranscriptEntries: config?.maxTranscriptEntries ?? 2000,
    fullscreen: config?.fullscreen ?? false,
    theme: config?.theme ?? 'auto',
    agentPreset: config?.agentPreset,
    title: config?.title ?? 'DeepSeek Harness',
  }
}