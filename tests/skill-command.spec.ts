import { describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../src/ui/commands/context.js'
import type { SkillsCatalog } from '../src/ui/commands/services.js'

import { skillCommand, skillsReport, SKILLS_PER_PAGE } from '../src/ui/commands/skills.js'
import type { SkillRow, SkillSummaryLike } from '../src/runtime/skill-catalog.js'
import { createPalette } from '../src/ui/theme.js'

type SkillView = NonNullable<Parameters<SkillsCatalog['list']>[0]>

interface Notice {
  readonly tone: string
  readonly text: string
}

interface Overlay {
  render(width: number): string[]
  handleInput(data: string): void
}

/** One catalog entry in the shape `ctx.skills.list()` returns. */
function entry(name: string, overrides: Partial<SkillSummaryLike> = {}): SkillSummaryLike {
  return {
    name,
    description: name + " does a thing.",
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-agents',
    provider: 'filesystem',
    ...overrides,
  }
}

interface Harness {
  readonly ctx: CommandContext & { notices: Notice[] }
  readonly overlays: Overlay[]
  /** Skill names the handler asked the editor to stage, in order. */
  readonly staged: string[]
  /** Deliver Escape the way the terminal would, closing the open overlay. */
  pressEscape(): void
}

/**
 * A command context whose only mounted service is the skill registry.
 *
 * The overlay list lets a test read what a dialog rendered and drive its keys,
 * which is how the picker and the body pager are checked end to end.
 */
function harness(options: {
  readonly list?: (options: SkillView) => Promise<readonly SkillSummaryLike[]>
  readonly get?: (name: string, options: SkillView) => Promise<{ content: string } | undefined>
  readonly activeCwd?: string
  readonly noRegistry?: boolean
} = {}): Harness {
  const notices: Notice[] = []
  const overlays: Overlay[] = []
  const registry = options.noRegistry === true
    ? undefined
    : {
      list: options.list ?? (async () => [entry("alpha"), entry("beta")]),
      ...(options.get === undefined ? {} : { get: async (name: string, view: SkillView) => options.get?.(name, view) }),
    }
  const listeners: Array<(data: string) => unknown> = []
  const tui = {
    terminal: { columns: 120 },
    showOverlay(component: Overlay) {
      overlays.push(component)
      return { hide() {}, focus() {} }
    },
    addInputListener(listener: (data: string) => unknown) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    requestRender() {},
  }
  const host = {
    get: (name: string) => name === 'skills' ? registry : undefined,
    on: () => () => undefined,
    commands: { list: () => [] },
  }
  const staged: string[] = []
  const ctx = {
    notices,
    host: host as unknown as CommandContext['host'],
    config: { cwd: '/tmp', title: 't', theme: 'auto', fullscreen: false } as unknown as CommandContext['config'],
    palette: createPalette('plain'),
    tui: tui as unknown as CommandContext['tui'],
    active: { id: 'session-1', agent: { ctx: { get: () => undefined }, session: { header: { cwd: options.activeCwd }, snapshotEvents: () => [] } } } as unknown as CommandContext['active'],
    signal: new AbortController().signal,
    notice: (tone: string, text: string) => { notices.push({ tone, text }) },
    renderStatus: () => undefined,
    attachments: { pending: [], clear: () => undefined },
    runCommand: async () => undefined,
    openTuiSettings: async () => undefined,
    showHostSettings: () => undefined,
    modelSelection: { current: undefined, assembled: undefined },
    setContextWindow: () => undefined,
    readContext: () => ({ metrics: { turns: 0, steps: 0, totalTokens: 0 }, breakdown: undefined }),
    stageSkillInvocation: (name: string) => { staged.push(name) },
    persistSelection: async () => undefined,
  } as unknown as CommandContext & { notices: Notice[] }
  // A paged overlay resolves only when it is dismissed, so the harness has to be
  // able to close one the way a key press would.
  const pressEscape = (): void => {
    // The pager listens globally; a choice dialog owns the key itself. Both are
    // offered the press, and each ignores the one that is not its own.
    for (const listener of [...listeners]) listener(String.fromCharCode(27))
    const overlay = overlays.at(-1) as Partial<Overlay> | undefined
    if (typeof overlay?.handleInput === 'function') overlay.handleInput(String.fromCharCode(27))
  }
  return { ctx, overlays, staged, pressEscape }
}

/** Let pending promises settle so an overlay has been handed to the surface. */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Every line a notice carries, joined for substring assertions. */
function noticeText(ctx: { notices: Notice[] }): string {
  return ctx.notices.map(notice => notice.text).join('\n')
}

/** One normalized row, for the pure report tests. */
function row(name: string, overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    name,
    description: name + ' does a thing.',
    userInvocable: true,
    modelInvocable: true,
    provenance: 'user-agents',
    ...overrides,
  }
}

describe('skills report', () => {
  it('states the total and the invocation split above the rows', () => {
    const text = skillsReport([
      row('alpha'),
      row('beta', { userInvocable: false }),
    ], { width: 120 })
    expect(text.split('\n')[0]).toBe('2 skills · 1 user-invocable · 1 model-only')
    expect(text).toContain('alpha')
    // A skill both surfaces allow lists both flags; the model-only row drops u.
    expect(text).toContain('[u,m:user-agents]')
    expect(text).toContain('[m:user-agents]')
  })

  it('singularizes a one-skill catalog', () => {
    expect(skillsReport([row('only')], { width: 120 }).split('\n')[0])
      .toBe('1 skill · 1 user-invocable')
  })

  it('pages with the next page named in the header', () => {
    const rows = Array.from({ length: SKILLS_PER_PAGE * 2 }, (_, index) => row('s' + String(index)))
    const first = skillsReport(rows, { width: 120 })
    expect(first.split('\n')[0]).toContain('page 1/2')
    expect(first.split('\n')[0]).toContain('/skill list 2')
    // The last page names no successor.
    const last = skillsReport(rows, { width: 120, page: 2 })
    expect(last.split('\n')[0]).toContain('page 2/2')
    expect(last).not.toContain('/skill list 3')
  })

  it('says nothing is registered instead of printing an empty table', () => {
    expect(skillsReport([], { width: 120 })).toBe('No skills are registered for this session.')
  })

  it('points at both the invocation picker and the body reader', () => {
    const text = skillsReport([row('alpha')], { width: 120 })
    expect(text).toContain('Use /skill to pick one to invoke')
    expect(text).toContain('/skill read <name> to read one')
  })
})

describe('skill command', () => {
  it('pages the table through /skill list', async () => {
    const h = harness()
    await skillCommand(h.ctx, 'list')
    expect(h.ctx.notices).toHaveLength(1)
    expect(h.ctx.notices[0]?.tone).toBe('info')
    expect(noticeText(h.ctx)).toContain('2 skills')
  })

  it('rejects a non-numeric page instead of showing page one', async () => {
    const h = harness()
    await skillCommand(h.ctx, 'list later')
    expect(h.ctx.notices).toEqual([{ tone: 'warning', text: 'Usage: /skill [list [page] | read <name> | <name>]' }])
  })

  it('rejects a page below one', async () => {
    const h = harness()
    await skillCommand(h.ctx, 'list 0')
    expect(h.ctx.notices[0]?.tone).toBe('warning')
  })

  it('opens a searchable picker that shows every skill with its badge', async () => {
    // Browsing must include model-only skills: they are the ones a reader most
    // needs to see, because nothing asks permission before the model uses them.
    const h = harness({
      list: async () => [
        entry('alpha'),
        entry('beta', { invocation: { modelInvocable: true, userInvocable: false } }),
      ],
    })
    const running = skillCommand(h.ctx, '')
    await flush()
    expect(h.overlays).toHaveLength(1)
    const rendered = h.overlays[0]!.render(100).join('\n')
    // The picker is an invocation surface, so it offers only what a human may
    // call: the model-only entry stays visible in `/skill list` instead.
    expect(rendered).toContain('Invoke a skill · 1 available')
    expect(rendered).toContain('alpha')
    expect(rendered).not.toContain('beta')
    expect(rendered).toContain('[u,m:user-agents]')
    h.pressEscape()
    await running
    // Cancelling stages nothing and prints nothing.
    expect(h.staged).toEqual([])
    expect(h.ctx.notices).toEqual([])
  })

  it('stages the call chosen from the picker instead of sending it', async () => {
    const h = harness()
    const running = skillCommand(h.ctx, '')
    await flush()
    // Enter on the highlighted row stages the invocation in the editor.
    h.overlays[0]!.handleInput('\r')
    await flush()
    await running
    expect(h.staged).toEqual(['alpha'])
    // Nothing was sent, so no request can have started behind the user back.
    expect(h.overlays).toHaveLength(1)
    expect(noticeText(h.ctx)).toContain('Skill /skill:alpha added to the prompt')
  })

  it.each([
    ['/project-b', '/project-b'],
    [undefined, '/tmp'],
  ])('lists skills using the session cwd %s with a config fallback', async (activeCwd, expected) => {
    const list = vi.fn(async (_view: SkillView) => [entry('alpha')])
    const h = harness({ activeCwd, list })
    await skillCommand(h.ctx, 'list')
    expect(list).toHaveBeenCalledWith({ cwd: expected, scope: h.ctx.active.agent, signal: h.ctx.signal })
  })

  it('reads the body from the same active workspace as the catalog', async () => {
    const list = vi.fn(async (_view: SkillView) => [entry('alpha')])
    const get = vi.fn(async (_name: string, _view: SkillView) => ({ content: 'WORKSPACE B BODY' }))
    const h = harness({ activeCwd: '/project-b', list, get })
    const running = skillCommand(h.ctx, 'read alpha')
    await flush()
    try {
      const view = { cwd: '/project-b', scope: h.ctx.active.agent, signal: h.ctx.signal }
      expect(list).toHaveBeenCalledWith(view)
      expect(get).toHaveBeenCalledWith('alpha', view)
      expect(h.overlays[0]?.render(100).join(' ')).toContain('WORKSPACE B BODY')
    }
    finally {
      h.pressEscape()
      await running
    }
  })

  it('reports an unknown skill name and points at the list', async () => {
    const h = harness()
    await skillCommand(h.ctx, 'ghost')
    expect(h.ctx.notices).toEqual([{ tone: 'warning', text: 'No skill named "ghost". Use /skill to search.' }])
  })

  it('refuses cleanly when no skill service is mounted', async () => {
    const h = harness({ noRegistry: true })
    await skillCommand(h.ctx, 'list')
    expect(noticeText(h.ctx)).toContain('The skill service is unavailable in this profile.')
  })

  it('surfaces a discovery failure instead of an empty catalog', async () => {
    const h = harness({ list: async () => { throw new Error('registry offline') } })
    await skillCommand(h.ctx, 'list')
    expect(noticeText(h.ctx)).toContain('Could not list skills: registry offline')
  })

  it('says nothing is registered when the catalog is empty', async () => {
    const h = harness({ list: async () => [] })
    await skillCommand(h.ctx, 'list')
    expect(h.ctx.notices).toEqual([{ tone: 'info', text: 'No skills are registered for this session.' }])
  })

  it('stages an invocation through /skill <name>', async () => {
    const h = harness()
    await skillCommand(h.ctx, 'alpha')
    expect(h.staged).toEqual(['alpha'])
    // Staging is the whole effect: no overlay, no request.
    expect(h.overlays).toEqual([])
  })

  it('refuses to stage a model-only skill and points at reading it', async () => {
    // The Host rejects a model-only skill at the injection boundary, so the
    // command must not stage a call that would fail on send.
    const h = harness({
      list: async () => [entry('closed', { invocation: { modelInvocable: true, userInvocable: false } })],
    })
    await skillCommand(h.ctx, 'closed')
    expect(h.staged).toEqual([])
    expect(noticeText(h.ctx)).toContain('is model-only (no user invocation)')
    expect(noticeText(h.ctx)).toContain('/skill read closed')
  })

  it('says so when nothing can be invoked from the picker', async () => {
    const h = harness({
      list: async () => [entry('closed', { invocation: { modelInvocable: true, userInvocable: false } })],
    })
    await skillCommand(h.ctx, '')
    expect(h.overlays).toEqual([])
    expect(noticeText(h.ctx)).toContain('No user-invocable skills are registered')
  })

  it('shows a skill body through /skill read <name>', async () => {
    const h = harness({ get: async () => ({ content: 'SKILL BODY MARKER' }) })
    const running = skillCommand(h.ctx, 'read alpha')
    await flush()
    expect(h.ctx.notices).toEqual([])
    expect(h.overlays).toHaveLength(1)
    const rendered = h.overlays[0]!.render(100).join('\n')
    expect(rendered).toContain('SKILL BODY MARKER')
    expect(rendered).toContain('alpha')
    h.pressEscape()
    await running
  })

  it('still shows metadata when the provider returns no body', async () => {
    const h = harness()
    const running = skillCommand(h.ctx, 'read alpha')
    await flush()
    expect(h.overlays).toHaveLength(1)
    const rendered = h.overlays[0]!.render(100).join('\n')
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('Invoke with /skill:alpha')
    h.pressEscape()
    await running
  })

  it('reports a load failure without opening an empty pager', async () => {
    const h = harness({ get: async () => { throw new Error('gone') } })
    await skillCommand(h.ctx, 'read alpha')
    expect(h.overlays).toHaveLength(0)
    expect(noticeText(h.ctx)).toContain('Could not load skill "alpha": gone')
  })
})
