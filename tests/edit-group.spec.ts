import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { EditGroupCard, groupEdits } from '../src/ui/edit-group.js'
import { renderEditDiff } from '../src/ui/edit-card.js'
import { reduceTranscript, type TranscriptBlock, type TranscriptEntry } from '../src/ui/transcript.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'

type Tool = Extract<TranscriptBlock, { kind: 'tool' }>
const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
const tool = (id: string, overrides: Partial<Tool> = {}): Tool => ({
  kind: 'tool', name: 'edit', callId: id, turn: 1, args: JSON.stringify({ file_path: id + '.ts' }), pending: false,
  diffs: [{ path: id + '.ts', oldText: 'BEFORE_' + id + '\n', newText: 'AFTER_' + id + '\n' }], ...overrides,
})
const event = (type: string, data: unknown, seq: number): TranscriptEntry => ({
  type: 'event', event: { type, data, seq, time: 0 } as unknown as SessionEvent,
})
const text = (renderer: TranscriptRenderer, width = 100) => stripTerminalSequences(renderer.container.render(width).join('\n'))
const render = (tools: readonly Tool[], expanded = false, width = 100) => new EditGroupCard(tools, { ...options, toolsExpanded: expanded }).render(width).join('\n')

describe('edited files presentation', () => {
  it('groups consecutive calls under one total and keeps a separate file total and numbered diff', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([], [tool('a'), tool('b'), tool('c'), tool('d')])
    const output = text(renderer)
    expect(output).toContain('• Edited 4 files (+4 -4)')
    expect(output.match(/• Edited/gu)).toHaveLength(1)
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(output).toContain('└ ' + id + '.ts (+1 -1)')
      expect(output).toContain('1 - BEFORE_' + id)
      expect(output).toContain('1 + AFTER_' + id)
    }
    expect(output).toContain('Show details · ctrl+o')
    expect(output).not.toContain('• Edit ')
  })

  it('counts repeated paths once while preserving all applied hunks and cumulative operation totals', () => {
    const first = tool('a'), second = tool('b', { diffs: [{ path: 'a.ts', oldText: 'AFTER_a\n', newText: 'LAST_a\n' }] })
    const output = render([first, second])
    expect(output).toContain('Edited 1 file (+2 -2)')
    expect(output.match(/└ a\.ts/gu)).toHaveLength(1)
    expect(output).toContain('1 + AFTER_a')
    expect(output).toContain('1 - AFTER_a')
    expect(output).toContain('1 + LAST_a')
  })

  it.each([
    { pending: true }, { isError: true }, { stopped: true }, { diffs: [] },
    { name: 'read' }, { name: 'write', operation: 'create' as const },
  ])('keeps an ineligible call separate: %j', fields => {
    const block = tool('middle', fields)
    const groups = groupEdits([tool('a'), block, tool('b')])
    expect(groups).toHaveLength(3)
    expect(groups[1]).toBe(block)
  })

  it.each<TranscriptBlock>([
    { kind: 'assistant', text: 'Explain the change', live: false },
    { kind: 'notice', tone: 'info', text: 'Inspection' },
    { kind: 'user', text: 'Next task' },
    { kind: 'compaction', compactionId: 'c', state: 'done' },
  ])('does not cross a %s block', boundary => {
    expect(groupEdits([tool('a'), boundary, tool('b')])).toHaveLength(3)
  })

  it('does not combine different or unknown turns', () => {
    expect(groupEdits([tool('a'), tool('b', { turn: 2 })])).toHaveLength(2)
    expect(groupEdits([tool('a', { turn: undefined }), tool('b', { turn: undefined })])).toHaveLength(2)
  })

  it.each(['edit', 'apply_patch', 'write'])('accepts successful %s modifications with recorded hunks', name => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([], [tool('a', { name, operation: 'update' }), tool('b', { name, operation: 'update' })])
    expect(text(renderer)).toContain('Edited 2 files (+2 -2)')
  })

  it('keeps failed and stopped diagnostics and their partial diffs outside the success total', () => {
    const renderer = new TranscriptRenderer(options)
    renderer.set([], [tool('a'), tool('failed', { isError: true, result: 'ERROR_DETAIL' }),
      tool('stopped', { stopped: true, result: 'PARTIAL_DETAIL' }), tool('b')])
    const output = text(renderer)
    expect(output.match(/Edited 1 file/gu)).toHaveLength(2)
    for (const expected of ['ERROR_DETAIL', 'PARTIAL_DETAIL', '1 + AFTER_failed', '1 + AFTER_stopped', '└ error', 'stopped']) expect(output).toContain(expected)
    expect(output).not.toContain('Edited 4 files')
  })

  it('shows changed rows around a middle-of-file edit before expanding context', () => {
    const lines = Array.from({ length: 40 }, (_, i) => 'CONTEXT_' + i)
    const updated = [...lines]
    updated[20] = 'CHANGED_MIDDLE'
    const block = tool('a', { diffs: [{ path: 'a.ts', oldText: lines.join('\n'), newText: updated.join('\n') }] })
    const compact = render([block])
    expect(compact).toContain('21 - CONTEXT_20')
    expect(compact).toContain('21 + CHANGED_MIDDLE')
    expect(compact).not.toContain('CONTEXT_19')
    expect(render([block], true)).toContain('CONTEXT_19')
  })

  it('keeps exact and estimated totals stable across expansion and accounts for all hidden files', () => {
    const large = tool('large', { diffs: [{ path: 'large.ts', oldText: 'old\n'.repeat(500), newText: 'new\n'.repeat(500) }] })
    const all = [large, ...Array.from({ length: 12 }, (_, i) => tool(String(i)))]
    const compact = render(all), expanded = render(all, true)
    expect(compact.split('\n')[0]).toBe('• Edited 13 files (~+512 ~-512)')
    expect(expanded.split('\n')[0]).toBe(compact.split('\n')[0])
    expect(compact).toContain('5 more files')
    expect(compact).not.toContain('└ 11.ts')
    expect(expanded).toContain('└ 11.ts')
    const nearLimit = { path: 'limit.ts', oldText: 'same\n'.repeat(3) + 'a\n'.repeat(200) + 'tail\n'.repeat(3), newText: 'same\n'.repeat(3) + 'b\n'.repeat(200) + 'tail\n'.repeat(3) }
    expect(renderEditDiff(nearLimit, palette, false, { changedOnly: true, maxRows: 4 }).stats)
      .toEqual(renderEditDiff(nearLimit, palette, true).stats)
  })

  it('keeps expanded huge diffs bounded without changing the full operation counts', () => {
    const huge = tool('huge', { diffs: [{ path: 'huge.ts', oldText: 'old\n'.repeat(3000), newText: 'new\n'.repeat(3000) }] })
    const rows = new EditGroupCard([huge, tool('b')], { ...options, toolsExpanded: true }).render(80)
    expect(rows[0]).toBe('• Edited 2 files (~+3001 ~-3001)')
    expect(rows.length).toBeLessThanOrEqual(2005)
    expect(rows.some(row => row.includes('preview limit'))).toBe(true)
    expect(rows.every(row => visibleWidth(row) <= 80)).toBe(true)
  })

  it('retains the diagnostic for a line-ending-only modification', () => {
    const output = render([tool('a', { diffs: [{ path: 'a.ts', oldText: 'line\r\n', newText: 'line\n' }] })])
    expect(output).toContain('Edited 1 file (+0 -0)')
    expect(output).toContain('line endings changed')
  })

  it('retains local expansion when the pending native card settles into a group', () => {
    const renderer = new TranscriptRenderer(options), call = tool('a')
    renderer.set([], [{ ...call, pending: true, diffs: undefined }])
    const component = renderer.container.children[0]!
    component.handleMouse?.({ type: 'click', button: 'left', y: 0 } as never)
    renderer.set([], [call])
    expect(renderer.container.children[0]).toBe(component)
    expect(text(renderer)).toContain('Hide details')
  })

  it.each(['plain', 'dark', 'light'] as const)('escapes paths and source and fits narrow %s terminals', theme => {
    const palette = createPalette(theme)
    const unsafe = tool('a', { diffs: [{ path: 'src/中文👩‍💻/\x1b]52;c;PATH\x07.ts', oldText: 'before\x1b[31m', newText: 'after\x9b31m' }] })
    for (const width of [1, 2, 4, 12, 32, 80]) {
      const card = new EditGroupCard([unsafe, tool('b')], { ...options, palette })
      const rows = card.render(width)
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
      expect(rows.join('\n')).not.toContain('\x1b]52;')
      expect(rows.join('\n')).not.toContain('\x9b')
      if (theme === 'plain') expect(rows.join('\n')).not.toContain('\x1b')
    }
    const rows = new EditGroupCard([tool('a')], { ...options, palette }).render(80)
    if (theme !== 'plain') {
      expect(rows[0]).toContain(palette.success('+1'))
      expect(rows[0]).toContain(palette.error('-1'))
      expect(rows.find(row => stripTerminalSequences(row).includes('1 +'))).toContain(theme === 'dark' ? '48;5;22' : '48;5;194')
    }
  })

  it('retains the first component and its local expansion while appending a successful call and refreshing colors', () => {
    const renderer = new TranscriptRenderer(options)
    const a = tool('a', { diffs: [{ path: 'a.ts', oldText: 'old\n'.repeat(15), newText: 'new\n'.repeat(15) }] })
    renderer.set([], [a])
    const component = renderer.container.children[0]!
    component.render(100)
    component.handleMouse?.({ type: 'click', button: 'left', x: 1, y: 0 } as never)
    expect(text(renderer)).toContain('Hide details')
    renderer.set([], [a, tool('b')])
    expect(renderer.container.children[0]).toBe(component)
    expect(text(renderer)).toContain('Hide details')
    renderer.refreshPalette()
    expect(text(renderer)).toContain('Hide details')
    renderer.toggleToolPreviews()
    renderer.toggleToolPreviews()
    expect(text(renderer)).toContain('Show details')
  })

  it('toggles through the details row while ignoring diff row clicks and modified clicks', () => {
    const card = new EditGroupCard([tool('a')], options)
    const rows = card.render(80)
    expect(card.handleMouse({ type: 'click', button: 'left', y: 2 } as never)).toBeUndefined()
    expect(card.handleMouse({ type: 'click', button: 'left', y: 0, ctrl: true } as never)).toBeUndefined()
    expect(card.handleMouse({ type: 'click', button: 'left', y: rows.length - 1 } as never)?.handled).toBe(true)
    expect(card.render(80).join('\n')).toContain('Hide details')
  })

  it('shortens absolute Host paths against the active session workspace and refreshes on workspace changes', () => {
    const renderer = new TranscriptRenderer(options)
    const edits = [tool('a', { diffs: [{ path: '/workspace/src/a.ts', oldText: 'old', newText: 'new' }] })]
    renderer.set([], edits, '/workspace')
    expect(text(renderer)).toContain('└ src/a.ts (+1 -1)')
    expect(text(renderer)).not.toContain('/workspace')
    const component = renderer.container.children[0]
    component?.handleMouse?.({ type: 'click', button: 'left', y: 0 } as never)
    renderer.set([], edits, '/workspace/src')
    expect(text(renderer)).toContain('└ a.ts (+1 -1)')
    expect(text(renderer)).toContain('Hide details')
    expect(renderer.container.children[0]).toBe(component)
  })

  it('applies the raw block window before grouping and does not resurrect pruned group members', () => {
    const renderer = new TranscriptRenderer({ ...options, maxEntries: 2 })
    const calls = [tool('a'), tool('b'), tool('c')]
    const events = calls.flatMap((call, index) => [
      event('tool/call', { turn: 1, step: 1, callId: call.callId, name: 'edit', arguments: call.args }, index * 2 + 1),
      event('tool/result', { turn: 1, step: 1, message: { source: { callId: call.callId }, content: [] }, meta: { diffs: call.diffs } }, index * 2 + 2),
    ])
    renderer.setEntries(events)
    expect(text(renderer)).toContain('Edited 2 files (+2 -2)')
    expect(text(renderer)).not.toContain('└ a.ts')
    expect(renderer.retainedFrom).toBeGreaterThan(0)
    renderer.setEntries(events.slice(renderer.retainedFrom))
    expect(text(renderer)).not.toContain('└ a.ts')
  })
})

describe.each([false, true])('edit group event projection (PTC: %s)', ptc => {
  it('propagates turn identity through settlement and groups matching file calls', () => {
    const events: TranscriptEntry[] = ptc ? [event('tool/call', { turn: 3, step: 1, callId: 'root', name: 'run_code', arguments: '{}' }, 1)] : []
    for (const [index, id] of ['a', 'b'].entries()) {
      const call = tool(id)
      const data = { turn: 3, step: index + 1, callId: id, rootCallId: 'root', parentCallId: 'root', subCallId: id, name: 'edit', arguments: call.args }
      events.push(event(ptc ? 'tool/ptc-dispatch-start' : 'tool/call', data, events.length + 1))
      events.push(event(ptc ? 'tool/ptc-dispatch' : 'tool/result', ptc ? { ...data, content: [], meta: { diffs: call.diffs } }
        : { turn: 3, step: index + 1, message: { source: { callId: id }, content: [] }, meta: { diffs: call.diffs } }, events.length + 1))
    }
    const settings = { ...options, runCodeDisplay: 'hidden' as const }
    expect(reduceTranscript(events, settings).filter(block => block.kind === 'tool').map(block => block.turn)).toEqual([3, 3])
    const renderer = new TranscriptRenderer(settings)
    renderer.setEntries(events)
    expect(text(renderer)).toContain('Edited 2 files (+2 -2)')
  })
})
