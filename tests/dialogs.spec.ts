import { describe, expect, it, vi } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { bindAbort, dialogFrame, showApproval, showChoice, showComponentPager, showMultilineInput, showQuestionBatch, showSearchChoice, showTextInput } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

describe('dialog cancellation', () => {
  it('settles a dialog whose signal aborted before it was registered', () => {
    // The dialog is built between the entry guard and the registration, so an
    // abort in that window must still close it instead of leaving it open.
    const controller = new AbortController()
    controller.abort()
    const onAbort = vi.fn()
    bindAbort(controller.signal, onAbort)
    expect(onAbort).toHaveBeenCalledOnce()
  })

  it('leaves a live signal attached until it aborts', () => {
    const controller = new AbortController()
    const onAbort = vi.fn()
    bindAbort(controller.signal, onAbort)
    expect(onAbort).not.toHaveBeenCalled()
    controller.abort()
    expect(onAbort).toHaveBeenCalledOnce()
  })
})

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
    // Enter confirms the row the list opens on, which is the fail-closed one.
    await expect(run(['\r'])).resolves.toMatchObject({ outcome: 'rejected' })
    const allowed = await run(['\x1b[B', '\r'])
    expect(allowed.outcome).toBe('allowed-once')
    expect(allowed.rendered).toContain('Approval required · run_code')
    expect(allowed.rendered).toContain('Write outside workspace')
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

  it('forwards cursor navigation and bracketed paste to the search box in showSearchChoice', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showSearchChoice({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Select model', [
      { value: 'provider/alpha', label: 'Alpha' },
      { value: 'provider/beta', label: 'Beta' },
      { value: 'provider/ab', label: 'AB' },
    ], 'Type to filter', new AbortController().signal)
    component!.handleInput('b')
    component!.handleInput('\x1b[D')
    component!.handleInput('a')
    expect(component!.render(84).join('\n')).toContain('AB')
    expect(component!.render(84).join('\n')).not.toContain('Beta')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('provider/ab')
  })

  it('never overflows narrow terminal widths in dialogFrame', () => {
    const palette = createPalette('plain')
    for (const width of [0, 3, 5, 12, 22]) {
      const lines = dialogFrame(['Title that is quite long'], width, palette)
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
    }
  })

  it('routes pager input via component handleInput without registering global listeners', async () => {
    const addInputListener = vi.fn()
    let overlay: { handleInput?(data: string): void; render(width: number): string[] } | undefined
    const promise = showComponentPager({
      terminal: { rows: 20 },
      requestRender() {},
      addInputListener,
      showOverlay(value: NonNullable<typeof overlay>) { overlay = value; return { hide() {}, focus() {} } },
    } as never, createPalette('plain'), 'Pager', { render: () => ['line 1'], invalidate() {} })
    expect(addInputListener).not.toHaveBeenCalled()
    overlay!.handleInput?.('\x1b[27u')
    await promise
  })

  it('re-applies background band SGR codes after inner resets', () => {
    const dark = createPalette('dark')
    expect(dark.dialogBand('a\x1b[0mb')).toContain('\x1b[0m\x1b[48;5;236m')
    expect(dark.diffAddBand('a\x1b[0mb')).toBe('\x1b[48;5;22ma\x1b[0m\x1b[48;5;22mb\x1b[49m')
  })
})

describe('text input dialog', () => {
  it('masks a secret value on screen while submitting and editing the real value', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showTextInput({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'API key', 'paste the key', 'Masked on screen · Esc cancels',
    new AbortController().signal, undefined, undefined, { secret: true })
    component!.handleInput('hunter2')
    const rendered = stripTerminalSequences(component!.render(60).join('\n'))
    expect(rendered).not.toContain('hunter2')
    expect(rendered).toContain('*******')
    expect(rendered).toContain('Masked on screen')
    component!.handleInput('\x7f')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('hunter')
  })

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
function overlayHarness(rows = 24): { tui: never; overlays: { render(width: number): string[]; handleInput(data: string): void }[] } {
  const overlays: { render(width: number): string[]; handleInput(data: string): void }[] = []
  const tui = {
    terminal: { rows, columns: 80 },
    requestRender() {},
    showOverlay(component: { render(width: number): string[]; handleInput(data: string): void }) {
      overlays.push(component)
      return { hide() {}, focus() {} }
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

describe('short terminals', () => {
  it('keeps the last choice inside the overlay height on a 12-row terminal', async () => {
    const { tui, overlays } = overlayHarness(12)
    const controller = new AbortController()
    const promise = showChoice(tui, createPalette('plain'), 'Pick one',
      Array.from({ length: 10 }, (_, index) => ({ value: 'item-' + index, label: 'Item ' + index })),
      'Enter selects', controller.signal)
    for (let index = 0; index < 9; index += 1) overlays[0]!.handleInput('\x1b[B')
    const lines = overlays[0]!.render(50)
    const selected = lines.findIndex(line => stripTerminalSequences(line).includes('› '))
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(selected).toBeLessThan(Math.floor(12 * 0.8))
    expect(stripTerminalSequences(lines[selected]!)).toContain('Item 9')
    expect(lines.every(line => visibleWidth(line) <= 50)).toBe(true)
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toBe('item-9')
  })
})

describe('question full details', () => {
  const palette = createPalette('plain')
  const detail = 'BEGIN ' + 'detail '.repeat(90) + 'END'

  it('opens the unclipped question from the View full details row and returns to it', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{
      id: 'pick', question: 'Pick one', detail, options: [{ label: 'ALPHA' }, { label: 'BETA' }],
    }], undefined)
    await flush()
    // Rows: ALPHA, BETA, Other…, Skip this question, View full details.
    for (let index = 0; index < 4; index += 1) overlays[0]!.handleInput('\x1b[B')
    expect(overlays[0]!.render(76).join('\n')).toContain('View full details')
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    const pager = stripTerminalSequences(overlays[1]!.render(100).join('\n'))
    expect(pager).toContain('BEGIN')
    expect(pager).toContain('END')
    overlays[1]!.handleInput('\x1b')
    await flush()
    expect(overlays).toHaveLength(3)
    overlays[2]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'pick', selected: ['ALPHA'] }] })
  })

  it('opens full details from a multi-select question without closing it', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{
      id: 'targets', question: 'Pick targets', detail, multiSelect: true,
      options: [{ label: 'CODE' }, { label: 'DOCS' }],
    }], undefined)
    await flush()
    // Rows: CODE, DOCS, Other…, Skip this question, View full details.
    for (let index = 0; index < 4; index += 1) overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await flush()
    expect(overlays).toHaveLength(2)
    expect(stripTerminalSequences(overlays[1]!.render(100).join('\n'))).toContain('END')
    overlays[1]!.handleInput('\x1b')
    await flush()
    expect(overlays).toHaveLength(2)
    for (let index = 0; index < 4; index += 1) overlays[0]!.handleInput('\x1b[A')
    overlays[0]!.handleInput(' ')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'targets', selected: ['CODE'] }] })
  })
})

describe('question overlay bounds', () => {
  const palette = createPalette('plain')

  it('keeps a long question detail from pushing the options off screen', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{
      id: 'pick',
      question: 'Pick one',
      detail: 'detail '.repeat(300),
      options: [{ label: 'ALPHA' }, { label: 'BETA' }],
    }], undefined)
    await flush()
    const rows = overlays[0]!.render(76)
    const screen = rows.join('\n')
    expect(rows.length).toBeLessThan(20)
    expect(screen).toContain('ALPHA')
    expect(screen).toContain('BETA')
    expect(screen).toContain('View full details')
    // Enter still submits the highlighted row; the list must have been visible.
    overlays[0]!.handleInput('\x1b[B')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toEqual({ answers: [{ id: 'pick', selected: ['BETA'] }] })
  })

  it('bounds a long multi-select question the same way', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showQuestionBatch(tui, palette, [{
      id: 'targets',
      question: 'Pick targets',
      detail: 'detail '.repeat(300),
      multiSelect: true,
      options: [{ label: 'CODE' }, { label: 'DOCS' }],
    }], undefined)
    await flush()
    const rows = overlays[0]!.render(76)
    expect(rows.length).toBeLessThan(20)
    expect(rows.join('\n')).toContain('CODE')
    expect(rows.join('\n')).toContain('DOCS')
    overlays[0]!.handleInput('\x1b')
    await expect(promise).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })
})

describe('prefilled values from Host settings', () => {
  const palette = createPalette('plain')

  it('strips terminal sequences from a single-line prefill', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showTextInput({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, palette, 'Wire value', 'high', 'Enter saves', new AbortController().signal,
    'high\u001b]8;;https://evil.example\u0007link')
    const rendered = stripTerminalSequences(component!.render(60).join('\n'))
    expect(rendered).not.toContain('\u001b')
    expect(rendered).not.toContain('\u0007')
    expect(rendered).not.toContain('evil.example')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('highlink')
  })

  it('strips terminal sequences from a multiline prefill while keeping its lines', async () => {
    const { tui, overlays } = overlayHarness()
    const promise = showMultilineInput(tui, palette, 'Edit schedule',
      'line one\nsecond \u001b]8;;https://evil.example/path\u0007line', 'Enter saves · Esc cancels')
    const rendered = stripTerminalSequences(overlays[0]!.render(60).join('\n'))
    expect(rendered).not.toContain('\u001b]8')
    expect(rendered).not.toContain('evil.example')
    expect(rendered).toContain('line one')
    overlays[0]!.handleInput('\r')
    await expect(promise).resolves.toBe('line one\nsecond line')
  })
})

describe('narrow multiline dialog', () => {
  const palette = createPalette('plain')

  it.each([2, 4, 6])('renders at %i columns without recursing through native wrapping', async width => {
    // A full-width grapheme at a one- or two-column editor makes pi-tui's
    // wordWrapLine recurse on itself; the dialog must not lay the editor out.
    const { tui, overlays } = overlayHarness()
    const promise = showMultilineInput(tui, palette, 'Edit schedule', '你好世界', 'Enter saves')
    const lines = overlays[0]!.render(width)
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
    overlays[0]!.handleInput('\x1b')
    await expect(promise).resolves.toBeUndefined()
  })
})
