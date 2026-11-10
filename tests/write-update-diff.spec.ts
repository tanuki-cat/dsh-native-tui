import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { reduceTranscript, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const path = 'demo.ts'
const before = 'const value = 1'
const after = 'const value = 2'
const args = { file_path: path, content: after }
const diff = { path, oldText: before, newText: after }
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 0 } as unknown as SessionEvent,
})

function entries(ptc: boolean, meta: unknown, isError = false): TranscriptEntry[] {
  const content = [{ type: 'text', text: isError ? 'WRITE_DIAGNOSTIC' : 'Updated file' }]
  return ptc ? [
    event('tool/ptc-dispatch-start', { parentCallId: 'outer', subCallId: 'write', name: 'write', arguments: args }, 1),
    event('tool/ptc-dispatch', { parentCallId: 'outer', subCallId: 'write', name: 'write', arguments: args, content, meta, isError }, 2),
  ] : [
    event('tool/call', { turn: 1, step: 1, callId: 'write', name: 'write', arguments: JSON.stringify(args) }, 1),
    event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'write' }, content, isError }, meta }, 2),
  ]
}

function render(events: TranscriptEntry[], expanded = false): string {
  const renderer = new TranscriptRenderer({ ...options, toolsExpanded: expanded })
  renderer.setEntries(events)
  return stripTerminalSequences(renderer.container.render(100).join('\n'))
}

describe.each([false, true])('write update diffs (PTC: %s)', ptc => {
  it.each([false, true])('renders applied updates instead of requested source (expanded: %s)', expanded => {
    const events = entries(ptc, { operation: 'update', diffs: [diff] })
    expect(reduceTranscript(events, options)[0]).toMatchObject({ name: 'write', operation: 'update', diffs: [diff] })
    const text = render(events, expanded)
    expect(text).toContain('• Edited 1 file (+1 -1)')
    expect(text).toContain('└ demo.ts (+1 -1)')
    expect(text).toContain('(+1 -1)')
    expect(text).toContain('1 - ' + before)
    expect(text).toContain('1 + ' + after)
    expect(text.match(/const value = 2/gu)).toHaveLength(1)
    expect(text).not.toContain('Updated file')
  })

  it('renders an update of an empty file as an insertion diff', () => {
    const text = render(entries(ptc, { operation: 'update', diffs: [{ ...diff, oldText: null }] }))
    expect(text).toContain('(+1 -0)')
    expect(text).toContain('1 + ' + after)
  })

  it('keeps created files as numbered source previews', () => {
    const events = entries(ptc, { operation: 'create', path, diffs: [] })
    expect(reduceTranscript(events, options)[0]).toMatchObject({ operation: 'create' })
    const text = render(events)
    expect(text).toContain('1  ' + after)
    expect(text).not.toContain('1 + ')
  })

  it('uses recorded old content for legacy updates without an operation', () => {
    expect(render(entries(ptc, { diffs: [diff] }))).toContain('1 - ' + before)
    const legacyCreate = render(entries(ptc, { diffs: [{ ...diff, oldText: null }] }))
    expect(legacyCreate).toContain('1  ' + after)
    expect(legacyCreate).not.toContain('1 + ')
  })

  it('keeps the source fallback when an update has no recorded diff', () => {
    const text = render(entries(ptc, { operation: 'update', diffs: [] }))
    expect(text).toContain('1  ' + after)
    expect(text).not.toContain('1 - ')
    expect(text).not.toContain('1 + ')
  })

  it('shows all applied hunks without substituting requested content', () => {
    const text = render(entries(ptc, { operation: 'update', diffs: [
      { path, oldText: 'FIRST_BEFORE', newText: 'FIRST_APPLIED' },
      { path, oldText: 'SECOND_BEFORE', newText: 'SECOND_APPLIED' },
    ] }))
    expect(text).toContain('1 - FIRST_BEFORE')
    expect(text).toContain('1 + FIRST_APPLIED')
    expect(text).toContain('1 - SECOND_BEFORE')
    expect(text).toContain('1 + SECOND_APPLIED')
    expect(text).toContain('• Edited 1 file (+2 -2)')
    expect(text.match(/└ demo\.ts/gu)).toHaveLength(1)
    expect(text).not.toContain(after)
  })

  it('updates a cached pending source card when the Host result arrives', () => {
    const events = entries(ptc, { operation: 'update', diffs: [diff] })
    const renderer = new TranscriptRenderer(options)
    renderer.setEntries(events.slice(0, 1))
    const pending = stripTerminalSequences(renderer.container.render(100).join('\n'))
    expect(pending).toContain('• Write demo.ts')
    expect(pending).toContain('running…')
    expect(pending).not.toContain('1 - ')
    renderer.setEntries(events)
    const settled = stripTerminalSequences(renderer.container.render(100).join('\n'))
    expect(settled).toContain('• Edited 1 file (+1 -1)')
    expect(settled).toContain('└ demo.ts (+1 -1)')
    expect(settled).toContain('1 - ' + before)
    renderer.toggleToolPreviews()
    expect(stripTerminalSequences(renderer.container.render(100).join('\n'))).toContain('1 + ' + after)
  })

  it('preserves applied diffs and errors on failed writes', () => {
    const text = render(entries(ptc, { operation: 'update', diffs: [diff] }, true))
    expect(text).toContain('1 - ' + before)
    expect(text).toContain('WRITE_DIAGNOSTIC')
    expect(text).toContain('└ error')
  })

  it('preserves applied diffs and diagnostics on partially stopped writes', () => {
    const text = render(entries(ptc, { operation: 'update', diffs: [diff], stopped: true }))
    expect(text).toContain('1 + ' + after)
    expect(text).toContain('Updated file')
    expect(text).toContain('stopped · partial changes retained')
  })
})
