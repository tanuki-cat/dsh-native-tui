import { describe, expect, it } from 'vitest'
import { assertResumed, reloadArgs, resumeIdFromEnv } from '../src/runtime/reload.js'

describe('reload arguments', () => {
  it('keeps launcher flags and appends the current session', () => {
    expect(reloadArgs(['--profile', 'tui', '--patch', 'extra.yml'], 'session-2'))
      .toEqual(['--profile', 'tui', '--patch', 'extra.yml', '--resume', 'session-2'])
    expect(reloadArgs(['tui'], 'session-2'))
      .toEqual(['tui', '--resume', 'session-2'])
  })

  it('replaces an existing resume flag instead of duplicating it', () => {
    expect(reloadArgs(['tui', '--resume', 'old'], 'new'))
      .toEqual(['tui', '--resume', 'new'])
    expect(reloadArgs(['--resume=old', '--profile=tui'], 'new'))
      .toEqual(['--profile=tui', '--resume', 'new'])
  })

  it('repairs a dangling resume flag', () => {
    expect(reloadArgs(['tui', '--resume'], 'new'))
      .toEqual(['tui', '--resume', 'new'])
    expect(reloadArgs(['tui', '--resume', '--patch', 'x'], 'new'))
      .toEqual(['tui', '--patch', 'x', '--resume', 'new'])
  })
})
describe('resume handoff', () => {
  it('accepts a session id exported by a reload', () => {
    expect(resumeIdFromEnv('native-tui-1bc15e8c-6d89-46b6-802c-0157f1cfb59b'))
      .toBe('native-tui-1bc15e8c-6d89-46b6-802c-0157f1cfb59b')
    expect(resumeIdFromEnv('  session_2  ')).toBe('session_2')
  })

  it('ignores an unusable value instead of trusting the environment', () => {
    expect(resumeIdFromEnv(undefined)).toBeUndefined()
    expect(resumeIdFromEnv('')).toBeUndefined()
    expect(resumeIdFromEnv('   ')).toBeUndefined()
    expect(resumeIdFromEnv('bad id with spaces')).toBeUndefined()
    expect(resumeIdFromEnv('x'.repeat(129))).toBeUndefined()
  })

  it('refuses a resume that landed on another session', () => {
    expect(() => assertResumed(undefined, 'fresh')).not.toThrow()
    expect(() => assertResumed('session-1', 'session-1')).not.toThrow()
    expect(() => assertResumed('session-1', 'session-2')).toThrow('instead of the requested')
  })
})
