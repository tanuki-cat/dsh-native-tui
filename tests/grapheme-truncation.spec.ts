import { describe, expect, it } from 'vitest'
import { sliceGraphemes } from '../src/ui/grapheme-preview.js'
import { compactErrorPreview, clip, ptcCallLine } from '../src/ui/tool-preview.js'
import { renderEditDiff } from '../src/ui/edit-card.js'
import { renderCodeExecutionCard } from '../src/ui/code-execution-card.js'
import { ToolCard } from '../src/ui/tool-card.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const hasLoneSurrogate = (text: string): boolean => LONE_SURROGATE.test(text)

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
type Block = Extract<TranscriptBlock, { kind: 'tool' }>
const tool = (overrides: Partial<Block> = {}): Block => ({
  kind: 'tool', callId: 't1', name: 'read', args: '{}', pending: false, ...overrides,
})

describe('grapheme-safe truncation', () => {
  it('never splits a surrogate pair in a head or tail slice', () => {
    // The emoji starts at code unit 2, so a UTF-16 slice at 3 would keep only
    // its high surrogate.
    expect(sliceGraphemes('aa😀aaa', 3)).toBe('aa')
    expect(sliceGraphemes('aaa😀aa', 3, 'end')).toBe('aa')
    expect(hasLoneSurrogate(sliceGraphemes('aa😀aaa', 3))).toBe(false)
    expect(hasLoneSurrogate(sliceGraphemes('aaa😀aa', 3, 'end'))).toBe(false)
  })

  it('keeps a clipped tool preview well formed', () => {
    expect(hasLoneSurrogate(clip('aa😀' + 'a'.repeat(20), 3))).toBe(false)
    expect(hasLoneSurrogate(compactErrorPreview('a'.repeat(218) + '😀' + 'tail'))).toBe(false)
  })

  it('keeps compact PTC call lines well formed when a tail slice lands on an emoji', () => {
    const line = ptcCallLine('read', JSON.stringify({ file_path: 'aa😀' + 'a'.repeat(62) }))
    expect(line.endsWith('…')).toBe(false)
    expect(line.startsWith('read …')).toBe(true)
    expect(hasLoneSurrogate(line)).toBe(false)
  })

  it('keeps a generic tool summary line well formed', () => {
    const value = 'a'.repeat(154) + '😀' + 'b'.repeat(20)
    const lines = new ToolCard(tool({ name: 'web_fetch', args: JSON.stringify({ foo: value }), result: undefined }), options).render(140)
    expect(hasLoneSurrogate(lines.join('\n'))).toBe(false)
  })

  it('keeps code preview lines well formed at the per-line budget', () => {
    const code = 'a'.repeat(158) + '😀' + 'b'.repeat(20)
    const block = tool({ name: 'run_code', args: JSON.stringify({ code }), result: undefined })
    expect(hasLoneSurrogate(renderCodeExecutionCard(block, options).render(140).join('\n'))).toBe(false)
  })

  it('keeps a large diff row well formed at the preview character budget', () => {
    const newText = 'a'.repeat(65535) + '😀' + 'b'.repeat(10)
    const lines = renderEditDiff({ path: 'big.txt', oldText: 'old', newText }, palette).render(80)
    expect(hasLoneSurrogate(lines.join('\n'))).toBe(false)
  })
})
