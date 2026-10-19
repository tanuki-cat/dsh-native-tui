import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { showApproval, showChoice, showQuestionBatch, showSearchChoice, showTextInput } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

describe('dialog frame', () => {
  it('renders a bounded opaque surface for a multiline title', async () => {
    let rendered: ReturnType<{ render(width: number): string[] }['render']> = []
    const controller = new AbortController()
    const promise = showChoice({
      showOverlay(component: { render(width: number): string[] }) {
        rendered = component.render(50)
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Approval required · run_code\n' + 'reason '.repeat(30), [
      { value: 'allow', label: 'Allow once', description: 'Approve this exact request only' },
      { value: 'reject', label: 'Reject', description: 'Fail the request closed' },
    ], 'Enter selects · Esc cancels', controller.signal)
    expect(rendered[0]?.startsWith('┌')).toBe(true)
    expect(rendered.at(-1)?.startsWith('└')).toBe(true)
    expect(rendered.every(line => visibleWidth(line) <= 50)).toBe(true)
    expect(rendered.every(line => !line.includes('\n'))).toBe(true)
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
  })

  it('maps approval choices and renders the request reason', async () => {
    const run = async (keys: string[]): Promise<{ outcome: string; rendered: string }> => {
      let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
      const promise = showApproval({
        showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
          component = value
          return { hide() {} }
        },
      } as never, createPalette('plain'), {
        toolName: 'run_code',
        callId: 'call-1' as never,
        reason: 'Write outside workspace',
      }, undefined)
      const rendered = component!.render(80).join('\n')
      for (const key of keys) component!.handleInput(key)
      return { outcome: await promise, rendered }
    }
    await expect(run(['\r'])).resolves.toMatchObject({ outcome: 'allowed-once' })
    const rejected = await run(['\x1b[B', '\r'])
    expect(rejected.outcome).toBe('rejected')
    expect(rejected.rendered).toContain('Approval required · run_code')
    expect(rejected.rendered).toContain('Write outside workspace')
    // The dialog offers an explicit Cancel row; Esc settles the same outcome.
    const cancelled = await run(['\x1b[B', '\x1b[B', '\r'])
    expect(cancelled.outcome).toBe('cancelled')
    expect(cancelled.rendered).toContain('Cancel')
    await expect(run(['\x1b'])).resolves.toMatchObject({ outcome: 'cancelled' })
  })

  it('filters a searchable choice list before selecting', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showSearchChoice({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Select model', [
      { value: 'provider/alpha', label: 'Alpha', description: 'fast' },
      { value: 'provider/beta', label: 'Beta', description: 'reasoning' },
    ], 'Type to filter · Enter selects', new AbortController().signal)
    component!.handleInput('bet')
    const filtered = component!.render(84).join('\n')
    expect(filtered).toContain('Beta')
    expect(filtered).not.toContain('Alpha')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('provider/beta')
  })
})

describe('text input dialog', () => {
  it('opens a prefilled value with the cursor at the end', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showTextInput({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Wire value', 'high', 'Enter saves', new AbortController().signal, 'high')
    component!.handleInput('x')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('highx')
  })
})

/** Minimal overlay host: capture each shown component and drive it with keys. */
function overlayHarness(): { tui: never; overlays: { render(width: number): string[]; handleInput(data: string): void }[] } {
  const overlays: { render(width: number): string[]; handleInput(data: string): void }[] = []
  const tui = {
    showOverlay(component: { render(width: number): string[]; handleInput(data: string): void }) {
      overlays.push(component)
      return { hide() {} }
    },
  }
  return { tui: tui as never, overlays }
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('user question dialogs', () => {
  const palette = createPalette('plain')

  it('answers a question without options through the Answer row', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{ id: 'free', question: 'Explain' }], undefined)
    await flush()
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    overlays[1]!.handleInput('hello')
    overlays[1]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'free', selected: [], custom: 'hello' }] })
  })

  it('skips a question without options through its Skip row', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{ id: 'free', question: 'Explain' }], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'free', selected: [] }] })
  })

  it('returns to the answer menu when the free-text submit is empty', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{ id: 'free', question: 'Explain' }], undefined)
    await flush()
    overlays[0]!.handleInput('\r')
    await flush()
    overlays[1]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(3)
    overlays[2]!.handleInput('\x1b[B')
    overlays[2]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'free', selected: [] }] })
  })

  it('returns to the option list when the Other submit is empty', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{ id: 'pick', question: 'Pick one', options: [{ label: 'A' }] }], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await flush()
    overlays[1]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(3)
    overlays[2]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'pick', selected: ['A'] }] })
  })

  it('selects a labelled option', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'pick', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'pick', selected: ['B'] }] })
  })

  it('returns free text from the Other row', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'pick', question: 'Pick one', options: [{ label: 'A' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    overlays[1]!.handleInput('why not')
    overlays[1]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'pick', selected: [], custom: 'why not' }] })
  })

  it('skips one question through its Skip row and keeps the batch', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'a', question: 'First', options: [{ label: 'A' }] },
      { id: 'b', question: 'Second', options: [{ label: 'B' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    // Second question rows are B, Other…, Skip this question.
    overlays[1]!.handleInput('\x1b[B')
    overlays[1]!.handleInput('\x1b[B')
    overlays[1]!.handleInput('\r')
    await expect(promise).resolves.toEqual({
      answers: [{ id: 'a', selected: ['A'] }, { id: 'b', selected: [] }],
    })
  })



  it('skips a multi-select question through its Skip row', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'targets', selected: [] }] })
  })

  it('cancels the whole batch with ASK_ABORTED on Esc', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'pick', question: 'Pick one', options: [{ label: 'A' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput('\x1b')
    await expect(promise).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  })

  it('toggles several options for a multi-select question', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }, { label: 'Docs' }] },
    ], undefined)
    await flush()
    const dialog = overlays[0]!
    expect(dialog.render(80).join('\n')).toContain('[ ] Code')
    dialog.handleInput(' ')
    expect(dialog.render(80).join('\n')).toContain('[x] Code')
    dialog.handleInput('\x1b[B')
    dialog.handleInput(' ')
    dialog.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'targets', selected: ['Code', 'Docs'] }] })
  })

  it('supplements checked multi-select labels with Other text', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }] },
    ], undefined)
    await flush()
    overlays[0]!.handleInput(' ')
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    overlays[1]!.handleInput('and tests')
    overlays[1]!.handleInput('\r')
    await expect(promise).resolves.toEqual({
      answers: [{ id: 'targets', selected: ['Code'], custom: 'and tests' }],
    })
  })

  it('refuses an empty multi-select submit until an option or Other is chosen', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }] },
    ], undefined)
    await flush()
    const dialog = overlays[0]!
    dialog.handleInput('\r')
    expect(dialog.render(80).join('\n')).toContain('Check at least one option')
    dialog.handleInput(' ')
    dialog.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'targets', selected: ['Code'] }] })
  })

  it('rejects with ASK_ABORTED when the request signal aborts', async () => {
    const controller = new AbortController()
    const { tui } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [
      { id: 'pick', question: 'Pick one', options: [{ label: 'A' }] },
    ], controller.signal)
    await flush()
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  })
})
