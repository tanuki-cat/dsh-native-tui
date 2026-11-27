import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { highlightCode } from '../src/ui/code-preview.js'
import { literalToolText, safeCut, ToolOutput, toolLabel } from '../src/ui/tool-output.js'
import { createPalette } from '../src/ui/theme.js'

vi.mock('../src/ui/code-preview.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/code-preview.js')>()
  return { ...actual, highlightCode: vi.fn(actual.highlightCode) }
})

const palette = createPalette('plain')
const highlighted = vi.mocked(highlightCode)

beforeEach(() => { highlighted.mockClear() })

/** A long body whose last line is distinctive, so a slice is easy to spot. */
const longBody = Array.from({ length: 1000 }, () => 'if then fi').join('\n')

describe('ToolOutput', () => {
  it('shows only the head and counts the lines it hides', () => {
    const body = Array.from({ length: 20 }, (_, index) => 'line ' + String(index)).join('\n')
    const lines = new ToolOutput(body, palette, false, 5).render(40)
    expect(lines.slice(0, 5).map(line => line.trim())).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4'])
    expect(lines.at(-1)).toContain('15 more lines')
  })

  it('keeps the diagnostic tail of a shell result', () => {
    const body = Array.from({ length: 20 }, (_, index) => 'line ' + String(index)).join('\n')
    const lines = new ToolOutput(body, palette, false, 5, 'end').render(40)
    expect(lines.slice(0, 5).map(line => line.trim())).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19'])
    expect(lines.at(-1)).toContain('15 earlier lines')
  })

  it('highlights only the window a collapsed card can show', () => {
    const collapsed = new ToolOutput(longBody, palette, false, 5, 'end', false, 'bash')
    const [collapsedSource] = highlighted.mock.calls.at(-1) ?? []
    expect(longBody.length).toBeGreaterThan(8192)
    expect(collapsedSource?.length).toBeLessThan(longBody.length)
    // The visible tail still renders, and the hidden prefix is not lost from the body.
    expect(collapsed.render(40).at(-2)?.trim()).toContain('if then fi')
    highlighted.mockClear()
    new ToolOutput(longBody, palette, true, 5, 'start', false, 'bash')
    expect(highlighted.mock.calls.at(-1)?.[0]).toBe(longBody)
  })

  it('keeps every line of a body well past the collapsed highlight window', () => {
    const collapsed = new ToolOutput(longBody, palette, false, 5, 'end', false, 'bash').render(40)
    expect(collapsed.at(-2)?.trim()).toBe('if then fi')
    const expanded = new ToolOutput(longBody, palette, true, 5, 'start', false, 'bash').render(40)
    expect(expanded).toHaveLength(1000)
    expect(expanded.at(-1)?.trim()).toBe('if then fi')
  })

  it('bounds a large body before normalizing and reports the exact omission count', () => {
    const raw = ('line\tvalue\r\n').repeat(20_000) + 'x'.repeat(1000)
    const full = literalToolText(stripTerminalSequences(raw)).trimEnd()
    const bounded = full.slice(0, safeCut(full, 65_536))
    const lines = new ToolOutput(raw, palette, true, 100_000).render(200)
    expect(lines.at(-1)?.trim()).toBe('… [' + String(full.length - bounded.length) + ' chars omitted by preview limit]')
    expect(lines[0]?.trimEnd()).toBe('line  value')
  })

  it('never splits a surrogate pair in a head or tail preview', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
    const head = new ToolOutput('x' + '\u{1F600}'.repeat(40_000), palette, true, 100_000).render(200).join('')
    expect(lone.test(head)).toBe(false)
    const tail = new ToolOutput('\u{1F600}'.repeat(40_000) + 'x', palette, true, 100_000, 'end').render(200).join('')
    expect(lone.test(tail)).toBe(false)
  })

  it('counts stripped escape sequences that sit between CR and LF', () => {
    // Stripping removes the SGR before CRLF normalization, so the pair collapses
    // into one newline; the omission count must follow that order.
    const raw = ('line\r\x1b[0m\n').repeat(20_000)
    const full = literalToolText(stripTerminalSequences(raw)).trimEnd()
    const lines = new ToolOutput(raw, palette, true, 100_000).render(200)
    expect(lines.at(-1)?.trim()).toBe('… [' + String(full.length - safeCut(full, 65_536)) + ' chars omitted by preview limit]')
  })
})

describe('tool labels', () => {
  it('truncates surrogate pairs without leaving an isolated half', () => {
    expect(toolLabel('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 6)).toBe('\u{1F600}\u{1F600}…')
    expect(toolLabel('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 6, 'end')).toBe('…\u{1F600}\u{1F600}')
    for (const label of [toolLabel('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 6),
      toolLabel('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 6, 'end')]) {
      // A well-formed string has no unpaired surrogate code unit.
      expect(/[\uD800-\uDFFF]/u.test(label)).toBe(false)
    }
  })
})
