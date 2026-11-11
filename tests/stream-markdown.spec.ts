import { describe, expect, it } from 'vitest'
import { Markdown, setCapabilityOverrides } from '@earendil-works/pi-tui'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { StreamMarkdown } from '../src/ui/stream-markdown.js'

const palette = createPalette('plain')
const theme = markdownTheme(palette)

/** Render the same source with the streaming wrapper and with one component. */
function expectSameAsMarkdown(stream: StreamMarkdown, text: string, width: number): void {
  expect(stream.render(width)).toEqual(new Markdown(text, 0, 0, theme).render(width))
}

const prose = 'The quick brown fox jumps over the lazy dog while the terminal keeps repainting. '
const fence = String.fromCharCode(96).repeat(3)

/** One document that covers the block shapes the split has to respect. */
const document = [
  '# Streaming markdown',
  '',
  prose.repeat(6),
  '',
  '- first bullet ' + prose.slice(0, 40),
  '- second bullet',
  '  continued on an indented line ' + prose.slice(0, 30),
  '',
  'Ordered:',
  '',
  '1. one',
  '2. two',
  '',
  '> quoted paragraph ' + prose.slice(0, 50),
  '>',
  '> second quoted paragraph',
  '',
  '| column | value |',
  '| --- | --- |',
  '| a | 1 |',
  '| b | 2 |',
  '',
  fence + 'ts',
  'const blank = "line inside a fence"',
  '',
  'const afterBlank = 2',
  fence,
  '',
  'A closing paragraph with **bold**, *italic* and `inline code` text.',
  '',
].join('\n')

describe('StreamMarkdown', () => {
  it('matches one Markdown component at every width', () => {
    for (const width of [20, 40, 60, 100]) {
      expectSameAsMarkdown(new StreamMarkdown(document, theme), document, width)
    }
  })

  it('matches while the document is still short enough to render as one block', () => {
    const short = 'A short paragraph.\n\nAnd a second one.'
    expectSameAsMarkdown(new StreamMarkdown(short, theme), short, 30)
  })

  it('matches a fresh Markdown after appending block by block', () => {
    const stream = new StreamMarkdown('', theme)
    let shown = ''
    for (const block of document.split('\n\n')) {
      shown += (shown === '' ? '' : '\n\n') + block
      stream.setText(shown)
      for (const width of [32, 64]) expectSameAsMarkdown(stream, shown, width)
    }
  })

  it('matches a fresh Markdown while one paragraph streams in', () => {
    const head = prose.repeat(20) + '\n\n'
    const stream = new StreamMarkdown(head, theme)
    stream.render(48)
    let tail = ''
    for (const chunk of prose.repeat(3).match(/.{1,9}/gu) ?? []) {
      tail += chunk
      stream.setText(head + tail)
      expectSameAsMarkdown(stream, head + tail, 48)
    }
  })

  it('matches a fresh Markdown when the source is replaced', () => {
    const stream = new StreamMarkdown(document, theme)
    stream.render(40)
    const replaced = 'Replaced body.\n\n' + prose.repeat(10)
    stream.setText(replaced)
    expectSameAsMarkdown(stream, replaced, 40)
  })

  it('never splits inside a fenced block that has grown past the threshold', () => {
    const head = (prose.repeat(8) + '\n\n').repeat(12)
    const body = head + fence + 'python\n' + 'x = 1\n\n'.repeat(400) + fence + '\n'
    const stream = new StreamMarkdown(body, theme)
    for (const width of [40, 80]) expectSameAsMarkdown(stream, body, width)
  })

  it('keeps rendering after a resize', () => {
    const stream = new StreamMarkdown(document, theme)
    stream.render(100)
    stream.render(30)
    expectSameAsMarkdown(stream, document, 30)
  })

  it('renders a document that defines link references whole', () => {
    // A reference definition resolves against the entire document: a split
    // would leave the half without the definition rendering it as literal text.
    // Hyperlink output is host-dependent, so force it for this assertion.
    setCapabilityOverrides({ hyperlinks: true })
    try {
      const body = prose.repeat(30) + '\n\nSee [the source][src] for details.\n\n'
        + prose.repeat(20) + '\n\n[src]: https://example.com\n'
      const painted = new StreamMarkdown(body, theme).render(40)
      expect(painted).toEqual(new Markdown(body, 0, 0, theme).render(40))
      expect(painted.filter(line => line.includes('\u001b]8;;'))).not.toHaveLength(0)
    } finally {
      setCapabilityOverrides({ hyperlinks: undefined })
    }
  })

  it('stops splitting once a reference definition arrives', () => {
    const head = prose.repeat(30)
    const stream = new StreamMarkdown(head, theme)
    stream.render(40)
    let shown = head
    for (const block of ['\n\nSee [the source][src].', '\n\n[src]: https://example.com', '\n\nAfter the definition.']) {
      shown += block
      stream.setText(shown)
      expectSameAsMarkdown(stream, shown, 40)
    }
  })

  it('treats a footnote definition the same way', () => {
    const body = prose.repeat(30) + '\n\nA claim needing [^1].\n\n' + prose.repeat(20)
      + '\n\n[^1]: The supporting note.\n'
    expectSameAsMarkdown(new StreamMarkdown(body, theme), body, 40)
  })
})
