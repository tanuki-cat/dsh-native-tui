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
