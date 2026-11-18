import { describe, expect, it } from 'vitest'
import {
  assertResumed,
  clearReloadSession,
  peekReloadSession,
  RELOAD_SESSION_TTL_MS,
  rememberReloadSession,
  reloadArgs,
  resumeIdFromEnv,
} from '../src/runtime/reload.js'

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

describe('in-process reload handoff', () => {
  it('hands the on-screen session to a replacement and clears it once opened', () => {
    clearReloadSession()
    expect(peekReloadSession()).toBeUndefined()
    rememberReloadSession('native-tui-a')
    expect(peekReloadSession()).toBe('native-tui-a')
    rememberReloadSession('native-tui-b')
    expect(peekReloadSession()).toBe('native-tui-b')
    clearReloadSession()
    expect(peekReloadSession()).toBeUndefined()
  })

  it('refuses a handoff older than its window instead of resuming it later', () => {
    clearReloadSession()
    rememberReloadSession('native-tui-a', 1_000)
    expect(peekReloadSession(RELOAD_SESSION_TTL_MS, 2_000)).toBe('native-tui-a')
    expect(peekReloadSession(RELOAD_SESSION_TTL_MS, 1_000 + RELOAD_SESSION_TTL_MS + 1)).toBeUndefined()
    // The stale claim is gone, so a still-current read finds nothing either.
    expect(peekReloadSession(RELOAD_SESSION_TTL_MS, 2_000)).toBeUndefined()
  })

  it('keeps a retry inside the window working', () => {
    clearReloadSession()
    rememberReloadSession('native-tui-a', 5_000)
    expect(peekReloadSession(RELOAD_SESSION_TTL_MS, 6_000)).toBe('native-tui-a')
    expect(peekReloadSession(RELOAD_SESSION_TTL_MS, 7_000)).toBe('native-tui-a')
    clearReloadSession()
  })
})
