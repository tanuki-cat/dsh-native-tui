import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { AssistantMessage } from '../src/ui/assistant-message.js'
import { MessageBody } from '../src/ui/transcript-chrome.js'
import { StreamText } from '../src/ui/stream-text.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

describe('MessageBody', () => {
  it('decorates only changed lines when StreamText mutates its cached array', () => {
    const dim = vi.fn((text: string) => text)
    const palette = { ...createPalette('plain'), dim }
    const prefix = Array.from({ length: 200 }, (_, index) => 'finished line ' + index).join('\n') + '\n'
    const stream = new StreamText(prefix)
    const body = new MessageBody(stream, palette, '• ')
    body.render(80)
    dim.mockClear()
    stream.setText(prefix + 'new tail')
    const lines = body.render(80)
    expect(lines.at(-1)?.trim()).toBe('new tail')
    expect(lines[0]?.trim()).toBe('• finished line 0')
    expect(dim).toHaveBeenCalledTimes(1)
    body.render(80)
    expect(dim).toHaveBeenCalledTimes(1)
  })

  it('does not decorate completed reasoning again when only the answer changes', () => {
    const dim = vi.fn((text: string) => text)
    const palette = { ...createPalette('plain'), dim }
    const reasoning = Array.from({ length: 200 }, (_, index) => 'reasoning line ' + index).join('\n')
    const block = { kind: 'assistant' as const, live: true, reasoning, text: 'answer' }
    const message = new AssistantMessage(block, { showReasoning: true, thinkingDisplay: 'detailed',
      maxEntries: 600, palette, markdown: markdownTheme(palette) })
    message.render(80)
    dim.mockClear()
    message.update({ ...block, text: 'answer continued' })
    const lines = message.render(80).map(stripTerminalSequences).join('\n')
    expect(lines).toContain('reasoning line 199')
    expect(lines).toContain('answer continued')
    expect(dim.mock.calls.length).toBeLessThan(10)
  })

  it.each(['dark', 'light', 'plain'] as const)('matches fresh output across append, replace, shrink and resize in %s', theme => {
    const palette = createPalette(theme)
    const stream = new StreamText('')
    const body = new MessageBody(stream, palette, '• ')
    for (const text of ['中文 👩‍💻\n\u001b[32mcolored\u001b[39m', 'replacement\nsecond\nthird', 'short', '', 'restored']) {
      stream.setText(text)
      for (const width of [80, 10, 1, 80]) {
        const lines = body.render(width)
        expect(lines).toEqual(new MessageBody(new StreamText(text), palette, '• ').render(width))
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
      }
    }
  })

  it('tracks in-place replacement, shrink and growth without retaining removed rows', () => {
    const palette = createPalette('plain')
    const source = ['one', 'two', 'three']
    const body = new MessageBody({ render: () => source, invalidate: () => {} }, palette, '• ')
    body.render(20)
    source.splice(0, 3, 'changed')
    expect(body.render(20)).toEqual(['• changed'])
    source.push('new row')
    expect(body.render(20)).toEqual(['• changed', '  new row'])
    source.length = 0
    expect(body.render(20)).toEqual([])
  })

  it('invalidates decoration and the child when colors change', () => {
    let color = '\u001b[31m'
    const palette = { ...createPalette('dark'), dim: (text: string) => color + text + '\u001b[39m' }
    const content: Component = { render: () => ['body'], invalidate: vi.fn() }
    const body = new MessageBody(content, palette, '• ')
    expect(body.render(20)[0]).toContain('\u001b[31m')
    color = '\u001b[32m'
    body.invalidate()
    expect(body.render(20)[0]).toContain('\u001b[32m')
    expect(content.invalidate).toHaveBeenCalledOnce()
  })
})
