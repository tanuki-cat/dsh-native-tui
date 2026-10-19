import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { reduceTranscript, type TranscriptEntry } from '../src/ui/transcript.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'

function durable(type: string, data: unknown, seq: number): TranscriptEntry {
  return { type: 'event', event: { type, seq, time: 0, data } as unknown as SessionEvent }
}

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

  it('renders a tool card on the neutral dark surface', () => {
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
    expect(output).toContain('48;5;237')
    expect(output).not.toContain('48;5;22')
  })
})
