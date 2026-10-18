import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodebuddyCommand, type CodeBuddyCommandDeps } from '../src/runtime/codebuddy-command.js'

afterEach(() => { vi.restoreAllMocks() })

/** One authorization seam that announces a fixed page and commits nothing. */
function authorizationOf(url: string | undefined, outcome = 'authorized') {
  return {
    async begin(request: { interaction: { notify(notice: { message: string; url?: string; code?: string }): void } }) {
      request.interaction.notify({ message: 'requesting an authorization link' })
      if (url !== undefined)
        request.interaction.notify({ message: 'Authorize CodeBuddy in the browser, then return here.', url })
      // A repeated announce of the same URL must not open a second tab.
      if (url !== undefined)
        request.interaction.notify({ message: 'still waiting', url })
      return { status: outcome }
    },
  }
}

/** Everything the command needs, with the terminal side recorded. */
function depsOf(overrides: Partial<CodeBuddyCommandDeps> = {}): CodeBuddyCommandDeps & { notices: string[] } {
  const notices: string[] = []
  return {
    notices,
    service: undefined,
    authorization: authorizationOf('https://copilot.tencent.com/login?state=abc'),
    credentials: undefined,
    openUrl: () => true,
    signal: new AbortController().signal,
    notice: (level, text) => { notices.push(level + ': ' + text) },
    prompt: async () => undefined,
    ...overrides,
  }
}

describe('runCodebuddyCommand login', () => {
  it('opens the authorization URL once and keeps it in the notice', async () => {
    const opened: string[] = []
    const deps = depsOf({ openUrl: url => { opened.push(url); return true } })
    await runCodebuddyCommand('login cn', deps)
    expect(opened).toEqual(['https://copilot.tencent.com/login?state=abc'])
    const text = deps.notices.join('\n')
    expect(text).toContain('https://copilot.tencent.com/login?state=abc')
    expect(text).toContain('codebuddy: signed in')
    // The URL is announced once per deployment, not once per notice.
    expect(text).not.toContain('open this URL in a browser')
  })

  it('falls back to the printed URL when the browser cannot be opened', async () => {
    const deps = depsOf({ openUrl: () => false })
    await runCodebuddyCommand('login cn', deps)
    const text = deps.notices.join('\n')
    expect(text).toContain('open this URL in a browser')
    expect(text).toContain('https://copilot.tencent.com/login?state=abc')
  })

  it('keeps the flow alive when the opener throws', async () => {
    const deps = depsOf({ openUrl: () => { throw new Error('no browser') } })
    await runCodebuddyCommand('login cn', deps)
    const text = deps.notices.join('\n')
    expect(text).toContain('open this URL in a browser')
    expect(text).toContain('signed in')
  })

  it('opens one page per selected deployment', async () => {
    const opened: string[] = []
    const pages = ['https://copilot.tencent.com/login?state=cn', 'https://www.workbuddy.ai/login?state=en']
    let call = 0
    const deps = depsOf({
      authorization: {
        async begin(request: { interaction: { notify(notice: { message: string; url?: string }): void } }) {
          request.interaction.notify({ message: 'requesting an authorization link', url: pages[call++] })
          return { status: 'authorized' }
        },
      },
      openUrl: url => { opened.push(url); return true },
    })
    await runCodebuddyCommand('login all', deps)
    expect(opened).toEqual(pages)
  })

  it('does not open anything when the seam announces no URL', async () => {
    const opened: string[] = []
    const deps = depsOf({
      authorization: authorizationOf(undefined),
      openUrl: url => { opened.push(url); return true },
    })
    await runCodebuddyCommand('login cn', deps)
    expect(opened).toEqual([])
    expect(deps.notices.join('\n')).toContain('codebuddy: signed in')
  })

  it('works without an opener at all', async () => {
    const deps = depsOf({ openUrl: undefined })
    await runCodebuddyCommand('login cn', deps)
    const text = deps.notices.join('\n')
    expect(text).toContain('open this URL in a browser')
    expect(text).toContain('signed in')
  })
})
