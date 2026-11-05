import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { reduceTranscript, type TranscriptEntry } from '../src/ui/transcript.js'
import { ToolCard } from '../src/ui/tool-card.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({ type: 'event', event: { type, data, seq, time: 0 } as never })
const diffs = [{ path: 'deleted.ts', oldText: 'removed', newText: '' }, { path: 'moved.ts', oldText: null, newText: 'retained' }]
const input = '*** Begin Patch\n*** Delete File: deleted.ts\n*** End Patch'
const result = 'Patch stopped after 1 of 2 operations. The earlier change remains. FAILED_DESTINATION'
describe('native and PTC apply_patch cards', () => {
  it.each(['native', 'ptc'])('retains completed diffs and stopped diagnostics for %s partial execution', mode => {
    const entries = mode === 'native' ? [
      event('tool/call', { callId: 'patch', name: 'apply_patch', arguments: JSON.stringify({ input }) }, 1),
      event('tool/result', { message: { source: { callId: 'patch' }, isError: false, content: [{ type: 'text', text: result }] }, meta: { stopped: true, diffs } }, 2),
    ] : [
      event('tool/ptc-dispatch-start', { subCallId: 'patch', parentCallId: 'outer', name: 'apply_patch', arguments: { input } }, 1),
      event('tool/ptc-dispatch', { subCallId: 'patch', parentCallId: 'outer', name: 'apply_patch', arguments: { input }, content: [{ type: 'text', text: result }], meta: { stopped: true, diffs } }, 2),
    ]
    const block = reduceTranscript(entries, options).find(block => block.kind === 'tool' && block.name === 'apply_patch')
    expect(block).toMatchObject({ kind: 'tool', stopped: true, pending: false, diffs })
    if (block?.kind !== 'tool') throw new Error('Missing patch card')
    const text = stripTerminalSequences(new ToolCard(block, options).render(160).join('\n'))
    expect(text).toContain('deleted.ts'); expect(text).toContain('moved.ts')
    expect(text).toContain('FAILED_DESTINATION'); expect(text).toContain('stopped'); expect(text).not.toContain('└ done')
  })
  it('shows a dedicated pending PTC patch row before any diff exists', () => {
    const entries = [event('tool/ptc-dispatch-start', { subCallId: 'patch', parentCallId: 'outer', name: 'apply_patch', arguments: { input } }, 1)]
    expect(reduceTranscript(entries, options)).toContainEqual(expect.objectContaining({ name: 'apply_patch', pending: true }))
  })
})
