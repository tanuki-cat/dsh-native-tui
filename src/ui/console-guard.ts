/**
 * Keep Host and dependency logging off the terminal while the TUI owns it.
 *
 * The Host and its plugins log through `console`; DeepSeek's catalogue also
 * writes successful listing diagnostics to stderr with `console.error`. These calls
 * write straight to the terminal and land at the cursor, on top of a row the
 * renderer has already painted — a row of the status block or the prompt is
 * replaced by the line, and the next differential repaint does not repair it
 * because pi-tui still believes that row is unchanged.
 *
 * The TUI therefore owns `console` for as long as it owns the screen and hands
 * every call to its caller instead of the terminal: failures become transcript
 * notices, routine info goes to the opt-in debug trace. This mirrors
 * `warnings.ts`, which does the same for `process.emitWarning`.
 *
 * A catalogue failure is the one line that repeats while the network is down:
 * the Host announces it per route, again on every failed retry, and a laptop
 * that slept announces the same batch on every wake. The first copy of a
 * distinct failure is delivered as a notice; later copies carry
 * {@link ConsoleLine.repeat} so the caller can trace them instead of showing
 * the same row again.
 *
 * Scope: `console` only. A dependency that writes to `process.stdout` itself
 * still reaches the terminal; the mounted Host plugins only use `console`.
 *
 * @module dsh-native-tui/ui/console-guard
 */

import { format } from 'node:util'

/** Captured console level, normalized for known informational stderr diagnostics. */
export type ConsoleLevel = 'log' | 'info' | 'debug' | 'trace' | 'warn' | 'error' | 'dir'

/** One line a guarded console call produced. */
export interface ConsoleLine {
  readonly level: ConsoleLevel
  readonly text: string
  /** The line repeats a catalogue failure this guard already delivered. */
  readonly repeat?: true
}

/** Console output held while the terminal is owned by the UI. */
export interface ConsoleGuard {
  /** Restore every console method this guard replaced. */
  restore(): void
}

/** Options for {@link holdConsoleOutput}. */
export interface ConsoleGuardOptions {
  /** Receives one line per console call, in call order. */
  onLine: (line: ConsoleLine) => void
}

/** Console methods that write to the terminal. */
const CAPTURED = ['log', 'info', 'debug', 'trace', 'warn', 'error', 'dir'] as const

// Host listing success uses console.error only to keep diagnostics on stderr.
const LISTING_SUCCESS = /^\[llm-deepseek-(?:api-key|account)\] model listing from https?:\/\/[^\s]+ loaded \d+ model\(s\), skipped \d+ row\(s\)$/u

// A refresh that failed at the same URL for the same reason is the same
// advisory, whichever route announced it and whichever catalog it fell back to;
// the captured body is that identity.
const LISTING_FAILURE = /^\[llm-deepseek-(?:api-key|account)\] (model listing from https?:\/\/[^\s]+ failed \(.*\)); (?:using the bundled catalog|keeping the previous catalog)$/u

/** One console method this guard can replace. */
type CapturedMethod = (typeof CAPTURED)[number]

/** One replaced console method and the function it replaced. */
interface Replacement {
  readonly method: CapturedMethod
  readonly original: (...data: unknown[]) => void
}

/**
 * Hold `console` output until {@link ConsoleGuard.restore} runs.
 *
 * A line repeated at the same level is dropped: a catalogue that re-announces
 * the same listing would otherwise repeat one notice forever. A line
 * produced while the sink is still handling the previous one is dropped too, so
 * a sink that logs cannot recurse into itself. A catalogue failure that the
 * Host re-announces for every route and every retry is delivered on its first
 * copy and marked `repeat` afterwards, so one outage costs one notice.
 * @param options - sink for each captured line.
 * @returns the guard the caller releases when the terminal is restored.
 */
export function holdConsoleOutput(options: ConsoleGuardOptions): ConsoleGuard {
  const target = console as unknown as Record<string, ((...data: unknown[]) => void) | undefined>
  const replacements: Replacement[] = []
  // One advisory per distinct catalogue failure for this guard's lifetime.
  const announcedFailures = new Set<string>()
  let previousText: string | undefined
  let previousLevel: ConsoleLevel | undefined
  let delivering = false
  for (const method of CAPTURED) {
    const original = target[method]
    if (typeof original !== 'function') continue
    replacements.push({ method, original })
    target[method] = (...data: unknown[]): void => {
      const text = format(...data).trimEnd()
      const level = method === 'error' && LISTING_SUCCESS.test(text) ? 'info' : method
      // `console.log()` prints an empty line; there is nothing to report.
      if (text === '' || text === previousText && level === previousLevel || delivering) return
      previousText = text
      previousLevel = level
      const failure = LISTING_FAILURE.exec(text)?.[1]
      const repeat = failure !== undefined && announcedFailures.has(failure)
      if (failure !== undefined) announcedFailures.add(failure)
      delivering = true
      try {
        options.onLine(repeat ? { level, text, repeat: true } : { level, text })
      }
      finally {
        delivering = false
      }
    }
  }
  return {
    restore: () => {
      for (const replacement of replacements) target[replacement.method] = replacement.original
      replacements.length = 0
    },
  }
}

/**
 * Map one captured level to the transcript tone it deserves.
 * @param level - the console method that produced the line.
 * @returns the notice tone.
 */
export function consoleTone(level: ConsoleLevel): 'info' | 'warning' | 'error' {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  return 'info'
}
