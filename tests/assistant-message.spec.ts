import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { AssistantMessage } from '../src/ui/assistant-message.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const palette = createPalette('plain')
const options = {
  showReasoning: true,
  thinkingDisplay: 'compact' as const,
  maxEntries: 100,
  palette,
  markdown: markdownTheme(palette),
}
const render = (message: AssistantMessage): string => stripTerminalSequences(message.render(80).join('\n'))
type AssistantBlock = Extract<TranscriptBlock, { kind: 'assistant' }>

describe('AssistantMessage compact thinking', () => {
  it('leaves the streaming preview when the same reasoning settles', () => {
    const block: AssistantBlock = {
      kind: 'assistant',
      text: 'answer',
      reasoning: 'first paragraph line\nmore first\n\nsecond paragraph line\nmore second\n',
      live: true,
    }
    const message = new AssistantMessage(block, options)
    expect(render(message)).toContain('thinking · second paragraph line')
    message.update({ ...block, live: false })
    expect(render(message)).toContain('thinking · first paragraph line')
    expect(render(message)).not.toContain('second paragraph line')
  })
})

describe('AssistantMessage incremental sanitizing', () => {
  it('re-sanitizes a long OSC 8 body instead of appending to its leaked prefix', () => {
    const uri = 'https://example.com/' + 'a'.repeat(80)
    const opening = 'Read \u001b]8;;' + uri
    const block: AssistantBlock = { kind: 'assistant', text: opening, live: true }
    const message = new AssistantMessage(block, options)
    // The sequence is still open: only its introducer is stripped.
    expect(render(message)).toContain('a'.repeat(40))
    // Once the BEL arrives the whole body is a complete OSC sequence and must
    // disappear with it; an incremental append would keep the leaked prefix.
    message.update({ ...block, text: opening + '\u0007LINK\u001b]8;;\u0007' })
    const settled = render(message)
    expect(settled).toContain('LINK')
    expect(settled).not.toContain('example.com')
    expect(settled).not.toContain('a'.repeat(40))
  })
})
