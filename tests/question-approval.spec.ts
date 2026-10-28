import { describe, expect, it, onTestFinished } from 'vitest'
import { showQuestionBatch } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

const question: AskUserQuestionItem = {
  id: 'permission', question: 'Original question', detail: 'Limited access',
  options: [{ label: 'allow-once' }, { label: 'reject' }, { label: 'always-allow' }, { label: 'unrelated' }],
  intent: { kind: 'approval', approve: 'allow-once', reject: 'reject', always: 'always-allow', subject: { name: 'Editor' },
    display: { question: { en: 'Allow Editor access?' }, approve: { en: 'Allow once' } } },
}

function harness(item = question, signal?: AbortSignal) {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
  let hidden = 0
  const overlays: NonNullable<typeof component>[] = []
  const controller = new AbortController()
  const run = showQuestionBatch({ terminal: { rows: 18 }, requestRender() {}, showOverlay: (next: NonNullable<typeof component>) => { component = next; overlays.push(next); return { hide: () => { hidden += 1 }, focus() {} } } } as never, createPalette('plain'), [item], signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]))
  onTestFinished(async () => { controller.abort(); await run.catch(() => {}) })
  return { run, overlays, text: () => component!.render(90).join('\n'), press: (key: string) => component!.handleInput(key), hidden: () => hidden }
}

describe('permission question intent', () => {
  it('offers fixed actions, recognizes the subject and defaults to rejection', async () => {
    const h = harness()
    expect(h.text()).toContain('Editor')
    expect(h.text()).toContain('Allow Editor access?')
    expect(h.text()).toContain('Limited access')
    expect(h.text()).not.toContain('Other')
    expect(h.text()).not.toContain('Skip')
    expect(h.text()).not.toContain('unrelated')
    h.press('\r')
    await expect(h.run).resolves.toEqual({ answers: [{ id: 'permission', selected: ['reject'] }] })
    expect(h.hidden()).toBe(1)
  })

  it.each([1, 2])('returns the original option label for action %s', async down => {
    const h = harness()
    expect(h.text()).toContain('Allow once')
    for (let i = 0; i < down; i += 1) h.press('\x1b[B')
    h.press('\r')
    await expect(h.run).resolves.toEqual({ answers: [{ id: 'permission', selected: [down === 1 ? 'allow-once' : 'always-allow'] }] })
  })

  it.each(['escape', 'signal'])('cancels without granting when interrupted by %s', async mode => {
    const controller = new AbortController()
    const h = harness(question, controller.signal)
    const check = expect(h.run).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    if (mode === 'signal') controller.abort()
    else h.press('\x1b')
    await check
    expect(h.hidden()).toBe(1)
  })

  it('keeps fixed actions visible and pages every scope without granting', async () => {
    const h = harness({ ...question, question: 'Long header '.repeat(50), detail: 'Scope line'.repeat(300) + ' FINAL_SCOPE' })
    const lines = h.overlays[0]!.render(40)
    expect(lines.join(' ')).toContain('View full request details')
    expect(lines.join(' ')).toContain('reject')
    expect(lines.join(' ')).toContain('Allow once')
    expect(lines.length).toBeLessThanOrEqual(Math.floor(18 * 0.8))
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
    for (let i = 0; i < 3; i++) h.press(String.fromCharCode(27) + '[B')
    h.press(String.fromCharCode(13))
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(h.overlays).toHaveLength(2)
    const viewer = h.overlays[1]!
    let seen = '', settled = false
    void h.run.then(() => { settled = true })
    for (let i = 0; i < 100 && !seen.includes('FINAL_SCOPE'); i++) {
      const page = viewer.render(i % 2 === 0 ? 40 : 80)
      expect(page.length).toBeLessThanOrEqual(Math.floor(18 * 0.8))
      seen += page.join(' ')
      viewer.handleInput(String.fromCharCode(27) + '[6~')
    }
    expect(seen).toContain('FINAL_SCOPE')
    expect(settled).toBe(false)
    viewer.handleInput(String.fromCharCode(27))
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(h.overlays).toHaveLength(3)
    h.press(String.fromCharCode(13))
    await expect(h.run).resolves.toEqual({ answers: [{ id: 'permission', selected: ['reject'] }] })
  })

  it('cancels from full details without reopening or returning an answer', async () => {
    const controller = new AbortController(), h = harness(question, controller.signal)
    for (let i = 0; i < 3; i++) h.press(String.fromCharCode(27) + '[B')
    h.press(String.fromCharCode(13))
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(h.overlays).toHaveLength(2)
    const check = expect(h.run).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    controller.abort()
    await check
    expect(h.overlays).toHaveLength(2)
  })

  it('does not invent an always action and fails closed for a missing declared option', async () => {
    const noAlways = { ...question, intent: { kind: 'approval' as const, approve: 'allow-once', reject: 'reject' } }
    const h = harness(noAlways)
    expect(h.text()).not.toContain('always-allow')
    h.press('\r'); await h.run
    await expect(harness({ ...question, options: [{ label: 'reject' }] }).run).rejects.toThrow('missing a declared option')
  })
})
