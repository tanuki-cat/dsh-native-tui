import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const wide = '\u093E'.repeat(200)

describe('notice clipping', () => {
  it.each(['info', 'warning', 'error', 'success'] as const)('bounds an over-wide %s notice row', tone => {
    const block: TranscriptBlock = { kind: 'notice', tone, text: wide }
    const lines = renderTranscriptBlock(block, options).render(80)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true)
    expect(stripTerminalSequences(lines.join('\n'))).not.toBe('')
  })
})
