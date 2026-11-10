import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createPalette, editorTheme, markdownTheme } from '../src/ui/theme.js'
import { reduceTranscript, type TranscriptEntry } from '../src/ui/transcript.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'

function durable(type: string, data: unknown, seq: number): TranscriptEntry {
  return { type: 'event', event: { type, seq, time: 0, data } as unknown as SessionEvent }
}

describe('reasoning colors', () => {
  it('gives every selectable level a distinct color in both themes', () => {
    // The status line renders "think <level>"; a level without a color silently
    // renders dim, which reads as "this level has no visual state".
    for (const theme of ['dark', 'light'] as const) {
      const palette = createPalette(theme)
      const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      const rendered = levels.map(level => palette.reasoning(level)('x'))
      for (const [index, level] of levels.entries()) {
        expect(rendered[index], theme + ' has no colour for ' + level).not.toBe(palette.dim('x'))
      }
      expect(new Set(rendered).size, theme + ' reuses a colour across levels').toBe(levels.length)
    }
  })

  it('maps xhigh to a color between high and max', () => {
    expect(createPalette('dark').reasoning('xhigh')('x')).toContain('38;5;212')
    expect(createPalette('light').reasoning('xhigh')('x')).toContain('38;5;161')
  })

  it('maps low, medium, high, and max to theme-aware colors', () => {
    const dark = createPalette('dark')
    expect(dark.reasoning('low')('x')).toContain('38;5;28')
    expect(dark.reasoning('medium')('x')).toContain('38;5;117')
    expect(dark.reasoning('high')('x')).toContain('38;5;211')
    expect(dark.reasoning('max')('x')).toContain('38;5;196')

    const light = createPalette('light')
    expect(light.reasoning('medium')('x')).toContain('38;5;25')
    expect(light.reasoning('high')('x')).toContain('38;5;162')
    expect(light.reasoning('max')('x')).toContain('38;5;160')

    expect(dark.reasoning(undefined)('x')).toBe(dark.dim('x'))
    expect(createPalette('plain').reasoning('max')('x')).toBe('x')
  })

  it('gives presets a distinct hue and colors context by occupancy', () => {
    const dark = createPalette('dark')
    expect(dark.preset('ptc')).toContain('38;5;141')
    expect(dark.preset('ptc')).not.toBe(dark.accent('ptc'))
    expect(createPalette('light').preset('ptc')).toContain('38;5;91')

    expect(dark.context(undefined)('ctx —')).toBe(dark.dim('ctx —'))
    expect(dark.context(59)('ctx 59%')).toBe(dark.accent('ctx 59%'))
    expect(dark.context(60)('ctx 60%')).toContain('\u001B[33m')
    expect(dark.context(79)('ctx 79%')).toContain('\u001B[33m')
    expect(dark.context(80)('ctx 80%')).toContain('\u001B[31m')
    expect(dark.context(50, 75)('ctx 50%')).toBe(dark.accent('ctx 50%'))
    expect(dark.context(70, 75)('ctx 70%')).toContain('\u001B[33m')
    expect(dark.context(75, 75)('ctx 75%')).toContain('\u001B[31m')
    expect(createPalette('plain').context(90)('x')).toBe('x')
  })

  it('tints the three composition buckets like the Web meter', () => {
    // The Web panel tints system grey-blue, tools #a78bfa, messages blue-450.
    // The terminal keeps that mapping and only picks the nearest 256-color sits.
    const dark = createPalette('dark')
    expect(dark.contextBucket('system')('x')).toContain('38;5;245')
    expect(dark.contextBucket('tools')('x')).toContain('38;5;141')
    expect(dark.contextBucket('messages')('x')).toContain('38;5;39')
    // Light mode deepens each hue so it stays readable on a pale background.
    const light = createPalette('light')
    expect(light.contextBucket('system')('x')).toContain('38;5;243')
    expect(light.contextBucket('tools')('x')).toContain('38;5;98')
    expect(light.contextBucket('messages')('x')).toContain('38;5;25')
  })

  it('keeps the three buckets distinguishable from each other', () => {
    // Colour is the only thing separating the bar segments, so two buckets
    // sharing a hue would merge into one unreadable run.
    for (const theme of ['dark', 'light'] as const) {
      const palette = createPalette(theme)
      const tints = new Set([
        palette.contextBucket('system')('x'),
        palette.contextBucket('tools')('x'),
        palette.contextBucket('messages')('x'),
      ])
      expect(tints.size).toBe(3)
    }
    expect(createPalette('plain').contextBucket('tools')('x')).toBe('x')
  })

  it('keeps editor chrome neutral while reasoning remains distinguishable', () => {
    for (const theme of ['dark', 'light', 'plain'] as const) {
      const palette = createPalette(theme)
      expect(editorTheme(palette).borderColor?.('↑ 2')).toBe(palette.dim('↑ 2'))
      if (!palette.plain) expect(palette.reasoning('max')('max')).not.toBe(palette.dim('max'))
    }
  })
})

describe('palette bands', () => {
  it('uses a neutral tool surface instead of a saturated status color', () => {
    const dark = createPalette('dark')
    expect(dark.toolBand('x')).toContain('48;5;237')
    expect(dark.toolBand('x')).not.toContain('48;5;22')
    expect(createPalette('light').toolBand('x')).toContain('48;5;253')
    expect(createPalette('light').toolBand('x')).not.toContain('48;5;194')
  })

  it('keeps user, tool, and thinking bands distinct in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const palette = createPalette(theme)
      const bands = new Set([palette.userBand('x'), palette.toolBand('x'), palette.thinkingBand('x')])
      expect(bands.size).toBe(3)
    }
  })

  it('leaves plain mode without background styling', () => {
    const palette = createPalette('plain')
    expect(palette.plain).toBe(true)
    expect(palette.toolBand('x')).toBe('x')
  })

  it('renders tools without a full-width background', () => {
    const palette = createPalette('dark')
    const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }
    const entries: TranscriptEntry[] = [
      durable('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }, 1),
      durable('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file.txt' }],
          isError: false,
        },
      }, 2),
    ]
    const blocks = reduceTranscript(entries, options)
    const output = renderTranscriptBlock(blocks[0]!, options).render(80).join('\n')
    expect(output).not.toContain('48;5;237')
    expect(output).not.toContain('48;5;22')
  })
})
