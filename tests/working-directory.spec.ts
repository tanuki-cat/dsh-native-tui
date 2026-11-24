import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { currentWorkingDirectory } from '../src/runtime/working-directory.js'

const host = (service: unknown) => ({ get: () => service }) as unknown as Context
const session = (cwd?: string) => ({ header: { cwd } }) as unknown as Session

describe('currentWorkingDirectory', () => {
  it('uses the Host directory when the Session has moved', () => {
    expect(currentWorkingDirectory(host({ get: () => '/worktree' }), session('/original'), '/launch')).toBe('/worktree')
  })

  it('uses the header or launch directory when the service is absent', () => {
    expect(currentWorkingDirectory(host(undefined), session('/original'), '/launch')).toBe('/original')
    expect(currentWorkingDirectory(host(undefined), session(), '/launch')).toBe('/launch')
  })

  it('surfaces a mounted service failure rather than using an old directory', () => {
    const ctx = host({ get: () => { throw new Error('directory unavailable') } })
    expect(() => currentWorkingDirectory(ctx, session('/original'), '/launch')).toThrow('directory unavailable')
  })
})
