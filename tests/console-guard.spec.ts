import { describe, expect, it } from 'vitest'
import { consoleTone, holdConsoleOutput } from '../src/ui/console-guard.js'

/** Run one case with the real console, restoring it even when the case throws. */
function withRealConsole(run: (sink: { writes: string[] }) => void): void {
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  // Capture anything that still reaches console.log during the case so the
  // test runner's channel is not used and an escaped write stays observable.
  const writes: string[] = []
  console.log = (...data: unknown[]) => { writes.push(data.map(String).join(' ')) }
  try {
    run({ writes })
  }
  finally {
    console.log = originals.log
    console.info = originals.info
    console.warn = originals.warn
    console.error = originals.error
  }
}

describe('holdConsoleOutput', () => {
  it.each(['llm-deepseek-api-key', 'llm-deepseek-account'])('classifies %s successful stderr diagnostics as info', owner => {
    withRealConsole((sink) => {
      const lines: unknown[] = []
      const text = '[' + owner + '] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)'
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      try { console.error('[' + owner + ']', 'model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)') }
      finally { guard.restore() }
      expect(lines).toEqual([{ level: 'info', text }])
      expect(sink.writes).toEqual([])
    })
  })

  it.each([
    '[llm-deepseek-account] model listing from https://api.deepseek.com/models failed (503); keeping the previous catalog',
    '[llm-deepseek-api-key] authentication failed',
    '[other-plugin] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)',
    '[llm-deepseek-account-extra] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)',
    '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s); fatal error',
    '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\nrequest failed',
    'unrelated error',
  ])('retains error severity for %s', text => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      try { console.error(text) }
      finally { guard.restore() }
      expect(lines).toEqual([{ level: 'error', text }])
    })
  })

  it('retains warnings and does not deduplicate a severity change after an info diagnostic', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const text = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 0 model(s), skipped 3 row(s)'
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      try { console.error(text); console.warn(text); console.warn(text) }
      finally { guard.restore() }
      expect(lines).toEqual([{ level: 'info', text }, { level: 'warn', text }])
    })
  })

  const failure = (owner: string, reason: string, fallback = 'keeping the previous catalog'): string =>
    '[' + owner + '] model listing from https://api.deepseek.com/models failed (' + reason + '); ' + fallback

  it('announces a catalogue failure once, across routes and retries', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      const reach = failure('llm-deepseek-account', 'llmError: could not reach https://api.deepseek.com/models')
      const routed = failure('llm-deepseek-api-key', 'llmError: could not reach https://api.deepseek.com/models')
      const rejected = failure('llm-deepseek-account', 'llmError: https://api.deepseek.com/models answered HTTP 503')
      try {
        console.warn(reach)
        console.warn('[llm-deepseek-account] probe warning line')
        console.warn(routed)
        console.warn(reach)
        console.warn(rejected)
      }
      finally { guard.restore() }
      expect(lines).toEqual([
        { level: 'warn', text: reach },
        { level: 'warn', text: '[llm-deepseek-account] probe warning line' },
        { level: 'warn', text: routed, repeat: true },
        { level: 'warn', text: reach, repeat: true },
        { level: 'warn', text: rejected },
      ])
    })
  })

  it('keeps one failure family across a success and both fallbacks', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      const loaded = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)'
      const reach = failure('llm-deepseek-account', 'llmError: could not reach https://api.deepseek.com/models')
      const bundled = failure('llm-deepseek-account', 'llmError: could not reach https://api.deepseek.com/models', 'using the bundled catalog')
      try {
        console.warn(reach)
        console.error(loaded)
        console.warn(bundled)
      }
      finally { guard.restore() }
      expect(lines).toEqual([
        { level: 'warn', text: reach },
        { level: 'info', text: loaded },
        { level: 'warn', text: bundled, repeat: true },
      ])
    })
  })

  it('does not mark an unrelated warning repeated later as a repeat', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      try {
        console.warn('same')
        console.warn('other')
        console.warn('same')
      }
      finally { guard.restore() }
      expect(lines).toEqual([
        { level: 'warn', text: 'same' },
        { level: 'warn', text: 'other' },
        { level: 'warn', text: 'same' },
      ])
    })
  })

  it('routes console.info to the sink instead of the terminal', () => {
    withRealConsole((sink) => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      console.info('[llm-deepseek-account]', 'model listing loaded 2 model(s)')
      guard.restore()
      expect(lines).toEqual([{ level: 'info', text: '[llm-deepseek-account] model listing loaded 2 model(s)' }])
      expect(sink.writes).toEqual([])
    })
  })

  it('captures warn and error with their own level', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      console.warn('listing failed')
      console.error('boom')
      guard.restore()
      expect(lines).toEqual([
        { level: 'warn', text: 'listing failed' },
        { level: 'error', text: 'boom' },
      ])
    })
  })

  it('formats arguments the way console does', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      console.log('loaded %d model(s)', 2)
      console.log({ route: 'codebuddy' })
      guard.restore()
      expect(lines).toEqual([
        { level: 'log', text: 'loaded 2 model(s)' },
        { level: 'log', text: '{ route: \'codebuddy\' }' },
      ])
    })
  })

  it('drops an empty call and a line repeated in a row', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: line => { lines.push(line) } })
      console.log()
      console.info('same')
      console.info('same')
      console.info('other')
      console.info('same')
      guard.restore()
      expect(lines).toEqual([
        { level: 'info', text: 'same' },
        { level: 'info', text: 'other' },
        { level: 'info', text: 'same' },
      ])
    })
  })

  it('restores every console method it replaced', () => {
    withRealConsole(() => {
      const info = console.info
      const warn = console.warn
      const guard = holdConsoleOutput({ onLine: () => {} })
      expect(console.info).not.toBe(info)
      expect(console.warn).not.toBe(warn)
      guard.restore()
      expect(console.info).toBe(info)
      expect(console.warn).toBe(warn)
    })
  })

  it('restores methods without being called twice', () => {
    withRealConsole(() => {
      const info = console.info
      const guard = holdConsoleOutput({ onLine: () => {} })
      guard.restore()
      guard.restore()
      expect(console.info).toBe(info)
    })
  })

  it('does not recurse when the sink itself logs', () => {
    withRealConsole(() => {
      const lines: unknown[] = []
      const guard = holdConsoleOutput({ onLine: (line) => {
        lines.push(line)
        console.error('sink diagnostic')
      } })
      console.info('outer')
      guard.restore()
      expect(lines).toEqual([{ level: 'info', text: 'outer' }])
    })
  })
})

describe('consoleTone', () => {
  it('maps error to error, warn to warning, and everything else to info', () => {
    expect(consoleTone('error')).toBe('error')
    expect(consoleTone('warn')).toBe('warning')
    for (const level of ['log', 'info', 'debug', 'trace', 'dir'] as const) {
      expect(consoleTone(level)).toBe('info')
    }
  })
})
