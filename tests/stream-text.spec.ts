import { describe, expect, it } from 'vitest'
import { Text, visibleWidth } from '@earendil-works/pi-tui'
import { StreamText } from '../src/ui/stream-text.js'

/** A body long enough to wrap into many lines at a narrow width. */
const PROSE = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '

const fixtures: Record<string, string> = {
  empty: '',
  singleLine: 'hello',
  paragraphs: PROSE.repeat(3) + '\n\n' + PROSE.repeat(2),
  longParagraph: PROSE.repeat(40),
  manyLines: Array.from({ length: 60 }, (_, index) => 'line ' + index + ' ' + PROSE.slice(0, 20)).join('\n'),
  trailingNewline: PROSE.repeat(4) + '\n',
  blankLines: 'a\n\n\nb\n\n',
  tabs: 'col\tone\ncol\ttwo ' + PROSE.repeat(2),
  unicode: '中文段落需要按宽度换行，标点不能落到行首之外的错误位置。'.repeat(4) + '\n' + '👩‍💻 emoji ' + '🇨🇳 '.repeat(30),
  ansiFree: '- bullet one\n- bullet two\n  continued text ' + PROSE.repeat(2),
}

describe('StreamText', () => {
  it.each(Object.keys(fixtures))('renders %s exactly like Text', name => {
    const text = fixtures[name]!
    for (const width of [1, 2, 7, 20, 60, 120]) {
      expect(new StreamText(text).render(width)).toEqual(new Text(text, 0, 0).render(width))
    }
  })

  it.each(Object.keys(fixtures))('renders %s exactly like Text after resizing', name => {
    const text = fixtures[name]!
    const stream = new StreamText(text)
    stream.render(24)
    stream.render(80)
    expect(stream.render(24)).toEqual(new Text(text, 0, 0).render(24))
  })

  it('matches a fresh Text after every append', () => {
    const target = PROSE.repeat(6) + '\n\n' + PROSE.repeat(4) + '\ntail'
    const stream = new StreamText()
    let shown = ''
    for (const chunk of chunksOf(target, 7)) {
      shown += chunk
      stream.setText(shown)
      for (const width of [18, 40]) expect(stream.render(width)).toEqual(new Text(shown, 0, 0).render(width))
    }
  })

  it('matches after an append that completes a line', () => {
    const stream = new StreamText('alpha beta gamma')
    stream.render(10)
    stream.setText('alpha beta gamma\nsecond line that wraps around more than once')
    expect(stream.render(10)).toEqual(new Text('alpha beta gamma\nsecond line that wraps around more than once', 0, 0).render(10))
  })

  it('falls back to a fresh render when the text is replaced instead of appended', () => {
    const stream = new StreamText('first body that is long enough to wrap several times here')
    stream.render(20)
    stream.setText('replacement body that is also long enough to wrap at this width')
    expect(stream.render(20)).toEqual(new Text('replacement body that is also long enough to wrap at this width', 0, 0).render(20))
  })

  it('re-wraps only the tail a streaming append touched', () => {
    const body = Array.from({ length: 200 }, (_, index) => 'complete line ' + index + ' ' + PROSE.slice(0, 30)).join('\n')
    const stream = new StreamText(body + '\n')
    stream.render(80)
    const wasted = stream.wrappedCharacters
    expect(wasted).toBeGreaterThanOrEqual(body.length)
    stream.setText(body + '\nand the streaming tail')
    stream.render(80)
    // Only the new line is wrapped; the 200 completed lines are served from cache.
    expect(stream.wrappedCharacters - wasted).toBe('and the streaming tail'.length)
  })

  it('styles each rendered line without leaking state between them', () => {
    const text = PROSE.repeat(4)
    const stream = new StreamText(text, line => '[' + line + ']')
    const lines = stream.render(30)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(30)
      expect(line.startsWith('[')).toBe(true)
      expect(line.trimEnd().endsWith(']')).toBe(true)
    }
  })

  it('keeps the width when the terminal shrinks and grows again', () => {
    const text = PROSE.repeat(5)
    const stream = new StreamText(text)
    const wide = stream.render(60)
    expect(stream.render(20)).toEqual(new Text(text, 0, 0).render(20))
    expect(stream.render(60)).toEqual(wide)
  })
})

function* chunksOf(text: string, size: number): Generator<string> {
  for (let index = 0; index < text.length; index += size) yield text.slice(index, index + size)
}
