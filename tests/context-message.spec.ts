import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { ContextMessage } from '../src/ui/context-message.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock, TranscriptEntry } from '../src/ui/transcript.js'

const text = 'Context detail 中文😀\nSecond line\n' + 'long paragraph '.repeat(30)
const context: Extract<TranscriptBlock, { kind: 'context' }> = { kind: 'context', label: 'file-policy', text, seq: 1 }
const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const click = { type: 'click', button: 'left', x: 1, y: 0, screenX: 1, screenY: 0,
  width: 100, height: 1, shift: false, alt: false, ctrl: false } as const

describe('compact context messages', () => {
  it('shows only the source and expansion hint by default', () => {
    const lines = renderTranscriptBlock(context, options).render(100)
    expect(lines).toEqual(['◇ context · file-policy (ctrl+o to expand)'])
    expect(lines.join('\n')).not.toContain('Context detail')
    expect(context.text).toBe(text)
  })

  it('opens on click and collapses without changing the stored context', () => {
    const message = new ContextMessage(context, palette)
    expect(message.handleMouse(click)).toEqual({ handled: true })
    const expanded = message.render(100).join('\n')
    expect(expanded).toContain('(ctrl+o to collapse)')
    expect(expanded).toContain('  └ Context detail 中文😀')
    expect(expanded).toContain('    Second line')
    expect(message.handleMouse({ ...click, y: 1 })).toBeUndefined()
    expect(message.handleMouse({ ...click, shift: true })).toBeUndefined()
    expect(message.render(100).join('\n')).toBe(expanded)
    message.handleMouse(click)
    expect(message.render(100)).toHaveLength(1)
  })

  it('opens all context previews with Ctrl+O and retains them through stream updates', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.setNotices([context])
    const output = () => renderer.container.render(100).join('\n')
    expect(output()).not.toContain('Context detail')
    renderer.toggleToolPreviews()
    expect(output()).toContain('Context detail')
    renderer.setEntries([{ type: 'live', event: { type: 'assistant/live-chunk', seq: 1, time: 0, data: {
      attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'STREAMED ANSWER' },
    } } } as TranscriptEntry])
    expect(output()).toContain('Context detail')
    expect(output()).toContain('STREAMED ANSWER')
    renderer.toggleToolPreviews()
    expect(output()).not.toContain('Context detail')
    expect(output()).toContain('STREAMED ANSWER')
  })

  it('retains a clicked context through unrelated transcript appends', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.setNotices([context])
    renderer.container.handleMouse({ ...click, height: 1 })
    expect(renderer.container.render(100).join('\n')).toContain('Context detail')
    renderer.setNotices([context, { kind: 'notice', tone: 'info', text: 'other notice' }])
    expect(renderer.container.render(100).join('\n')).toContain('Context detail')
    expect(renderer.container.render(100).join('\n')).toContain('other notice')
  })

  it('does not advertise an empty context body as expandable', () => {
    const message = new ContextMessage({ ...context, text: '' }, palette)
    expect(message.render(100)).toEqual(['◇ context · file-policy'])
    expect(message.handleMouse(click)).toBeUndefined()
  })

  it.each(['plain', 'dark', 'light'] as const)('bounds folded and expanded %s rows and sanitizes terminal input', theme => {
    const palette = createPalette(theme)
    const message = new ContextMessage({ ...context, label: 'safe\x1b[2J\nlabel', text: text + '\x1b]52;c;abc\x07' }, palette)
    for (const expanded of [false, true]) {
      message.setExpanded(expanded)
      for (const width of [1, 2, 8, 32, 80]) {
        const lines = message.render(width)
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
        expect(lines.join('\n')).not.toContain('\x1b[2J')
        expect(lines.join('\n')).not.toContain('\x1b]52;')
        if (theme === 'plain') expect(lines.join('\n')).toBe(stripTerminalSequences(lines.join('\n')))
      }
    }
  })
})
