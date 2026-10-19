import { describe, expect, it } from 'vitest'
import type { SkillSuggestion } from '../src/ui/autocomplete.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { runCommandLine, type CommandRouterDeps } from '../src/ui/commands/router.js'
import { INIT_AGENTS_PROMPT } from '../src/runtime/init-prompt.js'

/** One recorded notice. */
interface Notice {
  readonly tone: string
  readonly text: string
}

/** A dispatcher whose every collaborator records what the line asked of it. */
function harness(options: { readonly hostResult?: unknown; readonly skills?: readonly SkillSuggestion[] } = {}) {
  const notices: Notice[] = []
  const calls: string[] = []
  const switched: Array<() => Promise<unknown>> = []
  const prompts: string[] = []
  let contextBuilds = 0
  const context = {
    host: {
      get: () => undefined,
      commands: {
        list: () => [],
        execute: async () => options.hostResult,
      },
    },
    config: { cwd: '/tmp', agentPreset: 'ptc' },
    palette: {},
    tui: {},
    active: { id: 'session-1', agent: { cancel: () => { calls.push('cancel') } } },
    signal: new AbortController().signal,
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: { current: undefined, assembled: undefined },
    setContextWindow: () => undefined,
    persistSelection: async () => undefined,
  } as unknown as CommandContext
  const deps: CommandRouterDeps = {
    context: () => { contextBuilds += 1; return context },
    switchTo: async next => { switched.push(next) },
    sendPrompt: text => { prompts.push(text) },
    clearTranscript: () => { calls.push('clearTranscript') },
    exit: code => { calls.push('exit:' + String(code)) },
    preset: {
      current: () => { calls.push('preset.current'); return 'ptc' },
      select: id => { calls.push('preset.select:' + id) },
    },
    skills: async () => options.skills ?? [],
  }
  return { deps, notices, calls, switched, prompts, contextBuilds: () => contextBuilds }
}

describe('command router', () => {
  it('exits without building a command context', async () => {
    const h = harness()
    await runCommandLine('/exit', h.deps)
    expect(h.calls).toEqual(['exit:0'])
    expect(h.contextBuilds()).toBe(0)
  })

  it('clears the transcript through the injected callback', async () => {
    const h = harness()
    await runCommandLine('/clear', h.deps)
    expect(h.calls).toEqual(['clearTranscript'])
    expect(h.contextBuilds()).toBe(0)
  })

  it('sends /init as a prompt', async () => {
    const h = harness()
    await runCommandLine('/init', h.deps)
    expect(h.prompts).toEqual([INIT_AGENTS_PROMPT])
  })

  it('opens a new session through the injected switch', async () => {
    const h = harness()
    await runCommandLine('/new', h.deps)
    // The factory stays lazy: the switch calls it once the old session is gone.
    expect(h.switched).toHaveLength(1)
    expect(typeof h.switched[0]).toBe('function')
  })

  it('passes an unknown name to the host before noticing it', async () => {
    const h = harness()
    await runCommandLine('/nope', h.deps)
    expect(h.notices).toEqual([{ tone: 'warning', text: 'Unknown command: /nope. Use /help for local and host commands.' }])
  })

  it('stays silent when the host command handled the line', async () => {
    const h = harness({ hostResult: { text: 'done' } })
    await runCommandLine('/nope', h.deps)
    expect(h.notices).toEqual([])
  })

  it('sends a user-invocable skill through as a prompt', async () => {
    const h = harness({ skills: [{ name: 'commit', description: 'write a commit', modelInvocable: true }] })
    await runCommandLine('/COMMIT now', h.deps)
    expect(h.prompts).toEqual(['/COMMIT now'])
    expect(h.notices).toEqual([])
  })
})
