import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runCodebuddyCommand,
  selectProfiles,
  type CodeBuddyCommandDeps,
  type CodeBuddyPromptSettings,
} from '../src/runtime/codebuddy-command.js'

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

/** A service that reports a fixed model list per route. */
function serviceOf(models: readonly {
  id: string
  inputModalities: string[]
  statedModalities: string[]
  declaredModalities?: string[]
  source: string
  degraded?: string
}[]) {
  return {
    models: () => models,
    status: () => [],
    refresh: async () => [],
    accessTokenFor: async () => '',
    logout: async () => {},
    credentialKey: () => '',
  }
}

/** One settings write the prompt flow made. */
interface PromptWrite {
  readonly kind: 'set' | 'unset'
  readonly value?: string
}

/** In-memory codebuddy settings namespace with revision accounting. */
function settingsOf(initial?: string, conflictOnce = false): CodeBuddyPromptSettings & { readonly writes: PromptWrite[] } {
  let custom = initial
  let revision = 1
  let conflict = conflictOnce
  const writes: PromptWrite[] = []
  return {
    writes,
    describe: () => [{
      ns: 'codebuddy',
      value: { systemPrompt: custom ?? '' },
      user: custom === undefined ? {} : { systemPrompt: custom },
      revision,
    }],
    mutate: async (_ns, ops, expected) => {
      if (conflict) {
        conflict = false
        revision += 1
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      if (expected !== undefined && expected !== revision) {
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      for (const op of ops) {
        if (op.op === 'unset') {
          custom = undefined
          writes.push({ kind: 'unset' })
          continue
        }
        custom = typeof op.value === 'string' ? op.value : undefined
        writes.push({ kind: 'set', value: String(op.value) })
      }
      revision += 1
    },
  }
}

/** Scripted overlay answers, recording the initial text each editor opened with. */
function surfaceOf(
  choices: readonly (string | undefined)[],
  edits: readonly (string | undefined)[],
  seen?: { readonly edits: string[] },
): Pick<CodeBuddyCommandDeps, 'choose' | 'editText'> {
  let choice = 0
  let edit = 0
  return {
    choose: async () => choices[choice++],
    editText: async (_title, initialValue) => {
      seen?.edits.push(initialValue)
      return edits[edit++]
    },
  }
}

describe('runCodebuddyCommand models', () => {
  it('lists each model with its declared modalities and source', async () => {
    const deps = depsOf({
      service: serviceOf([
        { id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'], statedModalities: ['text', 'image'], source: 'catalogue' },
        { id: 'hunyuan-chat', inputModalities: ['text'], statedModalities: ['text'], source: 'catalogue' },
        { id: 'default', inputModalities: ['text', 'image'], statedModalities: ['text'], source: 'override' },
      ]) as never,
    })
    await runCodebuddyCommand('models cn', deps)
    const text = deps.notices.join('\n')
    expect(text).toContain('deepseek-v4.1-flash')
    expect(text).toContain('text+image')
    expect(text).toContain('[override]')
    expect(text).toContain('text only')
  })

  it('names a catalogue claim the composition cannot honour', async () => {
    const deps = depsOf({
      service: serviceOf([
        {
          id: 'vision',
          inputModalities: ['text'],
          statedModalities: ['text', 'image'],
          declaredModalities: ['text', 'image'],
          source: 'catalogue',
          degraded: 'no-attachment-service',
        },
      ]) as never,
    })
    await runCodebuddyCommand('models en', deps)
    expect(deps.notices.join('\n')).toContain('no attachment service mounted')
  })

  it('does not blame the attachment service for a model that never declared images', async () => {
    // A text-only catalogue entry is not a narrowed declaration: naming the
    // attachment service here would report a limit that never applied.
    const deps = depsOf({
      service: serviceOf([
        { id: 'textual', inputModalities: ['text'], statedModalities: ['text'], declaredModalities: ['text'], source: 'catalogue' },
      ]) as never,
    })
    await runCodebuddyCommand('models en', deps)
    expect(deps.notices.join('\n')).not.toContain('no attachment service mounted')
  })

  it('says an operator override is inactive rather than reporting it as applied', async () => {
    // The override asked for images and the composition narrowed it back, so
    // the printed source must not read as a working override.
    const deps = depsOf({
      service: serviceOf([
        {
          id: 'default',
          inputModalities: ['text'],
          statedModalities: ['text'],
          declaredModalities: ['text', 'image'],
          source: 'override',
          degraded: 'no-attachment-service',
        },
      ]) as never,
    })
    await runCodebuddyCommand('models cn', deps)
    const text = deps.notices.join('\n')
    expect(text).toContain('override asks for images')
    expect(text).toContain('no attachment service mounted')
  })

  it('rejects an unknown models action', async () => {
    const deps = depsOf({ service: serviceOf([]) as never })
    await runCodebuddyCommand('models bogus', deps)
    expect(deps.notices.join('\n')).toContain('expected "/codebuddy models')
  })
})

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

describe('runCodebuddyCommand prompt', () => {
  it('adds a template through the guided flow', async () => {
    const settings = settingsOf()
    const seen = { edits: [] as string[] }
    const template = 'You are CodeBuddy, a coding assistant.\n\n{prompt}'
    const deps = depsOf({ settings, ...surfaceOf(['edit'], [template], seen) })
    await runCodebuddyCommand('prompt', deps)
    expect(seen.edits).toEqual(['{prompt}'])
    expect(settings.writes).toEqual([{ kind: 'set', value: template }])
    const text = deps.notices.join('\n')
    expect(text).toContain('saved')
    expect(text).toContain('keeps the harness prompt')
  })

  it('confirms before saving a template without the placeholder', async () => {
    const settings = settingsOf()
    const seen = { edits: [] as string[] }
    const deps = depsOf({ settings, ...surfaceOf(['edit', 'back', 'save'], ['Plain template.', 'Plain template.'], seen) })
    await runCodebuddyCommand('prompt', deps)
    // "Back" reopens the editor with the rejected draft.
    expect(seen.edits).toEqual(['{prompt}', 'Plain template.'])
    expect(settings.writes).toEqual([{ kind: 'set', value: 'Plain template.' }])
    expect(deps.notices.join('\n')).toContain('replaces the whole system prompt')
  })

  it('resets the template from the menu', async () => {
    const settings = settingsOf('Custom {prompt}')
    const deps = depsOf({ settings, ...surfaceOf(['reset'], []) })
    await runCodebuddyCommand('prompt', deps)
    expect(settings.writes).toEqual([{ kind: 'unset' }])
    expect(deps.notices.join('\n')).toContain('reset to the default')
  })

  it('clears the template when the editor is submitted empty', async () => {
    const settings = settingsOf('Custom {prompt}')
    const deps = depsOf({ settings, ...surfaceOf(['edit'], ['   ']) })
    await runCodebuddyCommand('prompt', deps)
    expect(settings.writes).toEqual([{ kind: 'unset' }])
    expect(deps.notices.join('\n')).toContain('reset to the default')
  })

  it('retries once when the profile revision moved', async () => {
    const settings = settingsOf(undefined, true)
    const deps = depsOf({ settings, ...surfaceOf(['edit'], ['Retry {prompt}']) })
    await runCodebuddyCommand('prompt', deps)
    expect(settings.writes).toEqual([{ kind: 'set', value: 'Retry {prompt}' }])
    expect(deps.notices.join('\n')).not.toContain('could not update')
  })

  it('prints the configured template and the default', async () => {
    const custom = settingsOf('Line one\nLine two {prompt}')
    const shown = depsOf({ settings: custom })
    await runCodebuddyCommand('prompt show', shown)
    const text = shown.notices.join('\n')
    expect(text).toContain('custom template')
    expect(text).toContain('Line one')
    expect(text).toContain('Line two {prompt}')

    const plain = depsOf({ settings: settingsOf() })
    await runCodebuddyCommand('prompt show', plain)
    expect(plain.notices.join('\n')).toContain('default')
  })

  it('reports a repeated reset without writing', async () => {
    const settings = settingsOf()
    const deps = depsOf({ settings })
    await runCodebuddyCommand('prompt reset', deps)
    expect(settings.writes).toEqual([])
    expect(deps.notices.join('\n')).toContain('already uses the default')
  })

  it('refuses the wizard without the settings service or an editor', async () => {
    const noSettings = depsOf()
    await runCodebuddyCommand('prompt', noSettings)
    expect(noSettings.notices.join('\n')).toContain('settings service is unavailable')

    const noEditor = depsOf({ settings: settingsOf() })
    await runCodebuddyCommand('prompt', noEditor)
    expect(noEditor.notices.join('\n')).toContain('no interactive editor')
  })

  it('rejects an unknown prompt action', async () => {
    const deps = depsOf({ settings: settingsOf() })
    await runCodebuddyCommand('prompt bogus', deps)
    expect(deps.notices.join('\n')).toContain('expected "/codebuddy prompt"')
  })
})

describe('runCodebuddyCommand targets', () => {
  it('does not resolve a prototype key to a deployment', () => {
    // A bare object lookup would return Object.prototype members for these and
    // pass an unrelated value on as a profile.
    expect(selectProfiles('constructor')).toBeUndefined()
    expect(selectProfiles('toString')).toBeUndefined()
    expect(selectProfiles('hasOwnProperty')).toBeUndefined()
    expect(selectProfiles('cn')?.map(profile => profile.id)).toEqual(['codebuddy'])
    expect(selectProfiles('codebuddy-en')?.map(profile => profile.id)).toEqual(['codebuddy-en'])
  })

  it('reports an unknown target without touching the credential store', async () => {
    const deleted: string[] = []
    const deps = depsOf({
      credentials: {
        readRecord: async () => undefined,
        modifyRecord: async () => undefined,
        deleteRecord: async (key) => { deleted.push(key) },
      },
    })
    await runCodebuddyCommand('logout constructor', deps)
    expect(deleted).toEqual([])
    expect(deps.notices.join('\n')).toContain('unknown target')
  })
})

describe('runCodebuddyCommand logout', () => {
  /** A credential store double that records deletes. */
  function storeOf(events: string[]) {
    return {
      async readRecord() { return undefined },
      async modifyRecord() { return undefined },
      async deleteRecord() { events.push('delete') },
    }
  }

  it('cancels an in-flight sign-in before deleting the credential', async () => {
    const events: string[] = []
    let inFlight = true
    const deps = depsOf({
      credentials: storeOf(events),
      wait: async () => { await Promise.resolve() },
      authorization: {
        async begin() { return { status: 'authorized' } },
        describe: () => ({ inFlight }),
        cancel: () => { events.push('cancel'); inFlight = false },
      },
    })
    await runCodebuddyCommand('logout cn', deps)
    // The delete is safe only after the polling flow has released the key.
    expect(events).toEqual(['cancel', 'delete'])
    expect(deps.notices.join('\n')).toContain('signed out')
  })

  it('waits for a cancelled sign-in that would otherwise commit the grant', async () => {
    let record: { kind: string; payload?: unknown } | undefined
    let inFlight = true
    const deps = depsOf({
      credentials: {
        async readRecord() { return record },
        async modifyRecord() { return undefined },
        async deleteRecord() { record = undefined },
      },
      wait: async () => { await Promise.resolve() },
      authorization: {
        async begin() { return { status: 'authorized' } },
        describe: () => ({ inFlight }),
        cancel: () => {
          // The flow settles asynchronously and commits its grant. A delete that
          // did not wait for that commit would be overwritten by it.
          void Promise.resolve().then(() => {
            record = { kind: 'grant', payload: { access: 'resurrected' } }
            inFlight = false
          })
        },
      },
    })
    await runCodebuddyCommand('logout cn', deps)
    expect(record).toBeUndefined()
    expect(deps.notices.join('\n')).toContain('signed out')
  })

  it('keeps the credential when a sign-in never settles', async () => {
    const events: string[] = []
    const deps = depsOf({
      credentials: storeOf(events),
      wait: async () => { await Promise.resolve() },
      authorization: {
        async begin() { return { status: 'cancelled' } },
        describe: () => ({ inFlight: true }),
        cancel: () => {},
      },
    })
    await runCodebuddyCommand('logout cn', deps)
    expect(events).toEqual([])
    expect(deps.notices.join('\n')).toContain('still settling')
  })
})

describe('runCodebuddyCommand refresh', () => {
  it('forwards the command signal to the catalogue refresh', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const controller = new AbortController()
    const deps = depsOf({
      service: {
        ...serviceOf([]),
        refresh: async (id: string, signal?: AbortSignal) => { seen.push(signal); return [{ id }] },
      } as never,
      signal: controller.signal,
    })
    await runCodebuddyCommand('models refresh cn', deps)
    // Cancelling the command must reach the network request it started.
    expect(seen).toEqual([controller.signal])
  })
})
