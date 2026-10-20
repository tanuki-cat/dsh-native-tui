import { describe, expect, it } from 'vitest'
import { reloadArgs } from '../src/runtime/reload.js'

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
