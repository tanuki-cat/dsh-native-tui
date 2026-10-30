import { describe, expect, it } from 'vitest'
import {
  firstLine,
  latestCompletedParagraphFirstLine,
  reasoningPreview,
  reasoningText,
} from '../src/ui/reasoning-text.js'

describe('reasoning display text', () => {
  it.each([
    '',
    'Ordinary reasoning',
    '普通思考正文',
    '\n  Original text  \n',
    '<note>Original text</note>',
  ])('preserves ordinary reasoning %j', (text) => {
    expect(reasoningText(text)).toBe(text)
  })

  it.each(['<', '<sig', '<signature>', '<signature>abc'])('hides an incomplete signature %j', (text) => {
    expect(reasoningText(text)).toBe('')
  })

  it('strips a complete signature block and the newlines after it', () => {
    expect(reasoningText('<signature>abc</signature>正文')).toBe('正文')
    expect(reasoningText('<signature>abc</signature>\n正文')).toBe('正文')
    expect(reasoningText('<signature>abc</signature>\r\n正文')).toBe('正文')
    expect(reasoningText('<signature>abc</signature>\n\n正文')).toBe('正文')
    expect(reasoningText('<signature>abc</signature> 正文')).toBe(' 正文')
  })
})

describe('reasoning line helpers', () => {
  it('reads the first line without surrounding whitespace', () => {
    expect(firstLine('first\nsecond')).toBe('first')
    expect(firstLine('  first  ')).toBe('first')
    expect(firstLine('')).toBe('')
  })

  it('anchors the preview to the last completed paragraph', () => {
    expect(latestCompletedParagraphFirstLine('only one line')).toBe('')
    expect(latestCompletedParagraphFirstLine('FIRST\nbody')).toBe('FIRST')
    expect(latestCompletedParagraphFirstLine('FIRST\nbody\n\nSECOND\nbody2')).toBe('SECOND')
    expect(latestCompletedParagraphFirstLine('FIRST\nbody\n\nSECOND')).toBe('FIRST')
    expect(latestCompletedParagraphFirstLine('FIRST\r\nbody\r\n\r\nSECOND\r\nbody2')).toBe('SECOND')
    expect(latestCompletedParagraphFirstLine('FIRST\nbody\n')).toBe('FIRST')
  })
})

describe('collapsed reasoning preview', () => {
  it('follows the last completed paragraph while streaming', () => {
    expect(reasoningPreview('FIRST\nbody\n\nSECOND\nmore', true)).toBe('SECOND')
  })

  it('shows the first line once the reasoning settled', () => {
    expect(reasoningPreview('FIRST\nbody\n\nSECOND\nmore', false)).toBe('FIRST')
  })

  it('keeps a visible line when no paragraph has completed yet', () => {
    expect(reasoningPreview('ONLY LINE', true)).toBe('ONLY LINE')
    expect(reasoningPreview('\n\n  LATER  \nrest', true)).toBe('LATER')
  })

  it('drops markdown emphasis markers', () => {
    expect(reasoningPreview('**bold** line\nbody', false)).toBe('bold line')
  })

  it('previews the text behind a signature', () => {
    expect(reasoningPreview('<signature>abc</signature>\nREAL\nbody', false)).toBe('REAL')
    expect(reasoningPreview('<signature>abc', true)).toBe('')
  })
})
