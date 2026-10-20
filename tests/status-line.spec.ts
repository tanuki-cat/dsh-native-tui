import { describe, expect, it } from 'vitest'
import { createPalette, type Palette } from '../src/ui/theme.js'
import { renderStatusRows, splitContextLine, splitSessionMetrics, type StatusInput } from '../src/ui/status-line.js'

function identity(text: string): string { return text }

const palette = {
  plain: true,
  dim: identity,
  bold: identity,
  italic: identity,
  underline: identity,
  accent: identity,
  brand: identity,
  success: identity,
  warning: identity,
  error: identity,
  userBand: identity,
  toolBand: identity,
  thinkingBand: identity,
  dialogBand: identity,
  dialogBorder: identity,
  reasoning: () => identity,
  preset: identity,
  context: () => identity,
} as unknown as Palette

function rows() {
  const state = { header: '', status: '', footer: '' }
  return {
    state,
    rows: {
      header: { setText: (text: string) => { state.header = text } },
      status: { setText: (text: string) => { state.status = text } },
      footer: { setText: (text: string) => { state.footer = text } },
    },
  }
}

function inputOf(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    title: 'Test TUI',
    sessionId: 'session-1',
    cwd: '/tmp/work',
    running: false,
    provider: 'provider',
    model: 'model',
    reasoningEffort: 'max',
    preset: 'ptc',
    attachmentCount: 0,
    contextWindow: 1_000_000,
    contextMeter: { tokens: 400_000 },
    stats: { turns: 2, steps: 3, decodeMs: 2000, decodeTokens: 100 },
    events: [],
    ...overrides,
  }
}

describe('renderStatusRows', () => {
  it('puts the title, session, and cwd on separate spaced header lines', () => {
    const { state, rows: target } = rows()
    renderStatusRows(target, palette, inputOf())
    expect(state.header).toBe('◆ Test TUI\nsession-1\n/tmp/work')
  })

  it('renders a spaced model/thinking block and a meta line', () => {
    const { state, rows: target } = rows()
    renderStatusRows(target, palette, inputOf({ attachmentCount: 2 }))
    expect(state.status).toContain('● idle')
    expect(state.status).toContain('model provider/model')
    expect(state.status).toContain('think max')
    expect(state.status).toContain('\n\n')
    expect(state.status).toContain('preset ptc')
    expect(state.status).toContain('attached 2')
    expect(state.status).toContain('enter send')
  })

  it('uses the running vocabulary and hides the default thinking label', () => {
    const { state, rows: target } = rows()
    renderStatusRows(target, palette, inputOf({ running: true, reasoningEffort: undefined }))
    expect(state.status).toContain('● working')
    expect(state.status).toContain('think default')
    expect(state.status).toContain('enter steer')
  })

  it('colors the thinking label through the reasoning palette hook', () => {
    const seen: Array<string | undefined> = []
    const colored = {
      ...palette,
      reasoning: (effort: string | undefined) => {
        seen.push(effort)
        return (text: string) => '[' + (effort ?? 'default') + ']' + text
      },
    } as unknown as Palette
    const { state, rows: target } = rows()
    renderStatusRows(target, colored, inputOf({ reasoningEffort: 'high' }))
    expect(seen).toEqual(['high'])
    expect(state.status).toContain('[high]think high')
  })

  it('colors the model pair, preset, attachments, and context head', () => {
    const colored = createPalette('dark')
    const { state, rows: target } = rows()
    renderStatusRows(target, colored, inputOf({ attachmentCount: 2, contextMeter: { tokens: 700_000 } }))
    expect(state.status).toContain('\u001B[34mprovider')
    expect(state.status).toContain('\u001B[36mmodel')
    expect(state.status).toContain('\u001B[38;5;141mptc')
    expect(state.status).toContain('\u001B[36m2')
    expect(state.footer).toContain('\u001B[36m↳ ')
    expect(state.footer).toContain('\u001B[33mctx 70%')
    expect(state.footer).toContain('\u001B[2m  (~700K / 1M · compact at 80%)')
  })

  it('turns the context head to error at the compaction trigger', () => {
    const { state, rows: target } = rows()
    renderStatusRows(target, createPalette('dark'), inputOf({ contextMeter: { tokens: 800_000 } }))
    expect(state.footer).toContain('\u001B[31mctx 80%')
  })

  it('puts usage and context on separate footer lines', () => {
    const { state, rows: target } = rows()
    renderStatusRows(target, palette, inputOf())
    expect(state.footer).toContain('↳ 2 turns')
    expect(state.footer).toContain('50 tok/s')
    expect(state.footer).toContain('\n  ctx 40%')
  })
})

describe('splitContextLine', () => {
  it('keeps the detail tail separate from the colored head', () => {
    expect(splitContextLine('ctx 40%  (~400K / 1M · compact at 80%)'))
      .toEqual({ head: 'ctx 40%', detail: '  (~400K / 1M · compact at 80%)' })
    expect(splitContextLine('ctx —')).toEqual({ head: 'ctx —', detail: '' })
  })
})

describe('splitSessionMetrics', () => {
  it('splits the context segment from the usage segments', () => {
    expect(splitSessionMetrics('2 turns  ·  3 steps  ·  50 tok/s  ·  1.5K tok  ·  cache 89%  ·  ctx 40%  (~400K / 1M · compact at 80%)'))
      .toEqual({
        usage: '2 turns  ·  3 steps  ·  50 tok/s  ·  1.5K tok  ·  cache 89%',
        context: 'ctx 40%  (~400K / 1M · compact at 80%)',
      })
  })

  it('leaves a metric row without context intact', () => {
    expect(splitSessionMetrics('2 turns  ·  3 steps')).toEqual({ usage: '2 turns  ·  3 steps', context: undefined })
  })
})
