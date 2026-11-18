import { beforeEach, describe, expect, it, vi } from 'vitest'
import { highlightCode } from '../src/ui/code-preview.js'
import { ToolOutput } from '../src/ui/tool-output.js'
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
})
