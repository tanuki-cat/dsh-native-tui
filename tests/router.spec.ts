import { describe, expect, it } from 'vitest'
import type { SkillSuggestion } from '../src/ui/autocomplete.js'
import type { CommandContext } from '../src/ui/commands/context.js'
import { runCommandLine, type CommandRouterDeps } from '../src/ui/commands/router.js'
import { INIT_AGENTS_PROMPT } from '../src/runtime/init-prompt.js'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'

/** One recorded notice. */
interface Notice {
  readonly tone: string
  readonly text: string
}

/** A dispatcher whose every collaborator records what the line asked of it. */
function harness(options: { readonly hostResult?: unknown; readonly skills?: readonly SkillSuggestion[]; readonly running?: boolean; readonly hostListThrows?: boolean; readonly contextThrows?: boolean } = {}) {
  const skillRegistry = {
    list: async () => [
      { name: 'alpha', description: 'first skill', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-agents', provider: 'filesystem' },
      { name: 'beta', description: 'second skill', invocation: { modelInvocable: true, userInvocable: false }, source: 'bundled', provider: 'bigpowers' },
    ],
  }
  const notices: Notice[] = []
  const calls: string[] = []
  const switched: Array<() => Promise<unknown>> = []
  const prompts: string[] = []
  const history: string[] = []
  let contextBuilds = 0
  const context = {
    host: {
      // The skill registry is the one service /skill needs; everything else
      // stays unmounted so a handler cannot quietly depend on it.
      get: (name: string) => name === 'skills' ? skillRegistry : undefined,
      commands: {
        list: () => {
          if (options.hostListThrows === true) throw new Error('registry exploded')
          return []
        },
        execute: async () => options.hostResult,
      },
    },
    config: { cwd: '/tmp', agentPreset: 'ptc' },
    palette: {},
    tui: {},
    active: { id: 'session-1', agent: { session: { header: { cwd: '/active-workspace' } }, status: options.running === true ? 'running' : 'idle', cancel: () => { calls.push('cancel') } } },
    signal: new AbortController().signal,
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: { current: undefined, assembled: undefined },
    setContextWindow: () => undefined,
    readContext: () => ({
      metrics: {
        turns: 1,
        steps: 2,
        totalTokens: 71_000,
        contextPercent: 6,
        contextEstimateTokens: 61_100,
        contextWindowTokens: 1_000_000,
        contextCompactPercent: 80,
      },
      breakdown: { systemTokens: 51_200, toolsTokens: 628, messageTokens: 10_900 },
    }),
    persistSelection: async () => undefined,
  } as unknown as CommandContext
  const deps: CommandRouterDeps = {
    context: () => {
      contextBuilds += 1
      if (options.contextThrows === true) throw new Error('context exploded')
      return context
    },
    switchTo: async next => { switched.push(next) },
    openNewSession: async (cwd, preset) => { calls.push('openNew:' + cwd + ':' + preset); return context.active },
    sendPrompt: (text, historyText = text) => { prompts.push(text); history.push(historyText) },
    clearTranscript: () => { calls.push('clearTranscript') },
    exit: code => { calls.push('exit:' + String(code)) },
    reload: () => { calls.push('reload') },
    preset: {
      current: () => { calls.push('preset.current'); return 'ptc' },
      select: id => { calls.push('preset.select:' + id) },
    },
    skills: async () => options.skills ?? [],
  }
  return { deps, notices, calls, switched, prompts, history, contextBuilds: () => contextBuilds }
}

describe('command router', () => {
  it('exits without building a command context', async () => {
    const h = harness()
    await runCommandLine('/exit', h.deps)
    expect(h.calls).toEqual(['exit:0'])
    expect(h.contextBuilds()).toBe(0)
  })

  it('reloads through the injected callback', async () => {
    const h = harness()
    await runCommandLine('/reload', h.deps)
    expect(h.calls).toEqual(['reload'])
  })

  it('refuses to reload while a turn is running', async () => {
    const h = harness({ running: true })
    await runCommandLine('/reload', h.deps)
    expect(h.calls).toEqual([])
    expect(h.notices).toEqual([{ tone: 'warning', text: 'Wait for the running turn to finish before /reload.' }])
  })

  it('rejects reload arguments', async () => {
    const h = harness()
    await runCommandLine('/reload now', h.deps)
    expect(h.calls).toEqual([])
    expect(h.notices).toEqual([{ tone: 'warning', text: 'Usage: /reload' }])
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
    expect(h.switched).toHaveLength(1)
    await h.switched[0]!()
    expect(h.calls).toContain('openNew:/active-workspace:ptc')
  })

  it('does not resume a second owner for the session already on screen', async () => {
    const h = harness()
    await runCommandLine('/resume session-1', h.deps)
    expect(h.switched).toEqual([])
  })

  it('dispatches /codex to the local handler', async () => {
    const h = harness()
    await runCommandLine('/codex status', h.deps)
    expect(h.notices.map(notice => notice.text).join('\n')).toContain('credential store is unavailable')
  })

  it('prints the context figures through the shared reader', async () => {
    const h = harness()
    await runCommandLine('/context', h.deps)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.tone).toBe('info')
    expect(h.notices[0]?.text).toContain('Context used: 6%')
    expect(h.notices[0]?.text).toContain('system prompt')
    expect(h.notices[0]?.text).toContain('tool definitions')
    expect(h.notices[0]?.text).toContain('messages')
  })

  it('rejects context arguments instead of ignoring them', async () => {
    const h = harness()
    await runCommandLine('/context 3', h.deps)
    expect(h.notices).toEqual([{ tone: 'warning', text: 'Usage: /context' }])
  })

  it('dispatches /skill to the local handler', async () => {
    const h = harness()
    await runCommandLine('/skill list', h.deps)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.text).toContain('2 skills')
    // The bundled provider names its package, not the generic root.
    expect(h.notices[0]?.text).toContain('[m:bigpowers]')
  })

  it('does not route /skill through the skill-invocation fallback', async () => {
    // A skill named exactly "skill" would otherwise be sent as a prompt; the
    // management command owns the name.
    const h = harness({ skills: [{ name: 'skill', description: 'shadowed', modelInvocable: true }] })
    await runCommandLine('/skill list', h.deps)
    expect(h.prompts).toEqual([])
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

  it.each([
    ['/skill:commit', '/commit'],
    ['/SKILL:COMMIT now', '/commit now'],
    ['/skill:commit  first\nsecond', '/commit  first\nsecond'],
    ['/skill:commit\twith tabs', '/commit\twith tabs'],
  ])('normalizes %s into a Host skill gesture', async (line, prompt) => {
    const h = harness({ hostResult: { text: 'must not intercept' }, skills: [{ name: 'commit', modelInvocable: true }] })
    await runCommandLine(line, h.deps)
    expect(h.prompts).toEqual([prompt])
    expect(h.history).toEqual([line])
    expect(h.notices).toEqual([])
  })

  it('can explicitly invoke a skill whose name belongs to a local command', async () => {
    const h = harness({ skills: [{ name: 'help', modelInvocable: false }] })
    await runCommandLine('/skill:help instructions', h.deps)
    expect(h.prompts).toEqual(['/help instructions'])
    expect(h.notices).toEqual([])
  })

  it.each(['exit', 'help'])('keeps a skill named %s callable when recalled from history', async name => {
    const h = harness({ skills: [{ name, modelInvocable: true }] })
    const editor = new PromptEditor({ terminal: { rows: 30 }, requestRender() {} } as never, editorTheme(createPalette('plain')))
    const line = '/skill:' + name
    await runCommandLine(line, h.deps)
    editor.addToHistory(h.history[0]!)
    editor.handleInput(String.fromCharCode(27) + '[A')
    expect(editor.getExpandedText()).toBe(line)
    await runCommandLine(editor.getExpandedText(), h.deps)
    expect(h.prompts).toEqual(['/' + name, '/' + name])
    expect(h.calls).toEqual([])
  })

  it.each(['/skill:', '/skill: instructions', '/skill:missing', '/skill:beta'])('does not send invalid skill calls: %s', async line => {
    const h = harness()
    await runCommandLine(line, h.deps)
    expect(h.prompts).toEqual([])
    expect(h.notices[0]?.tone).toBe('warning')
  })

  it('turns a throwing handler into one error notice instead of a rejection', async () => {
    // The terminal dispatches commands without awaiting them, so a rejection
    // here would escape as an unhandled rejection and end the process.
    const h = harness({ hostListThrows: true })
    await expect(runCommandLine('/help', h.deps)).resolves.toBeUndefined()
    expect(h.notices).toEqual([{ tone: 'error', text: 'Command failed: registry exploded' }])
  })

  it('survives a command context that cannot be built', async () => {
    const h = harness({ contextThrows: true })
    await expect(runCommandLine('/help', h.deps)).resolves.toBeUndefined()
    expect(h.notices).toEqual([])
  })

  it('refuses to stage a model-only skill instead of sending it', async () => {
    // beta is model-only in the harness registry. Staging it would produce a
    // line the Host rejects at the injection boundary, so the router must stop
    // before anything reaches the prompt.
    const h = harness()
    await runCommandLine('/skill beta', h.deps)
    expect(h.prompts).toEqual([])
    expect(h.notices[0]?.tone).toBe('warning')
    expect(h.notices[0]?.text).toContain('is model-only')
  })
})
