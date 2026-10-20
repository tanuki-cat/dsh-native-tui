import { describe, expect, it } from 'vitest'
import { holdProcessWarnings } from '../src/ui/warnings.js'

/** Run one case with the real emitter, restoring it even when the case throws. */
function withRealEmitter(run: () => void): void {
  const original = process.emitWarning
  try {
    run()
  }
  finally {
    process.emitWarning = original
  }
}

describe('holdProcessWarnings', () => {
  it('holds a warning instead of letting Node print it', () => {
    withRealEmitter(() => {
      const forwarded: unknown[][] = []
      const spy = ((...args: unknown[]) => { forwarded.push(args) }) as unknown as typeof process.emitWarning
      process.emitWarning = spy
      const guard = holdProcessWarnings()
      process.emitWarning('stripTypeScriptTypes is an experimental feature', 'ExperimentalWarning')
      expect(guard.restore()).toEqual(['ExperimentalWarning: stripTypeScriptTypes is an experimental feature'])
      // The held warning never reaches the emitter that would print it.
      expect(forwarded).toHaveLength(0)
      expect(process.emitWarning).toBe(spy)
    })
  })

  it('reads the type from an options object', () => {
    withRealEmitter(() => {
      const guard = holdProcessWarnings()
      process.emitWarning(new Error('buffer is deprecated'), { type: 'DeprecationWarning', code: 'DEP0005' })
      expect(guard.restore()).toEqual(['DeprecationWarning: buffer is deprecated'])
    })
  })

  it('keeps only the most recent warnings', () => {
    withRealEmitter(() => {
      const guard = holdProcessWarnings(2)
      process.emitWarning('one')
      process.emitWarning('two')
      process.emitWarning('three')
      expect(guard.restore()).toEqual(['Warning: two', 'Warning: three'])
    })
  })

  it('restores the emitter it replaced', () => {
    withRealEmitter(() => {
      const original = process.emitWarning
      const guard = holdProcessWarnings()
      expect(process.emitWarning).not.toBe(original)
      guard.restore()
      expect(process.emitWarning).toBe(original)
    })
  })
})
