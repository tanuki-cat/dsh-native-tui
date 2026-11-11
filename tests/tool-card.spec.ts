import { Text, stripTerminalSequences } from '@earendil-works/pi-tui'
import type { TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { ToolCard } from '../src/ui/tool-card.js'
import { literalToolText, toolLabel, ToolOutput } from '../src/ui/tool-output.js'
import { TranscriptRenderer } from '../src/ui/transcript-renderer.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'
import { HELP_LINES } from '../src/ui/commands/catalog.js'

const palette = createPalette('plain')
const options = { palette, markdown: markdownTheme(palette), showReasoning: true, maxEntries: 100 }
type Block = Extract<TranscriptBlock, { kind: 'tool' }>
const tool = (overrides: Partial<Block> = {}): Block => ({ kind: 'tool', callId: 't1', name: 'read', args: '{"file_path":"src/a.ts"}', pending: false, result: 'READ_CONTENT', ...overrides })
const output = (card: ToolCard, width = 100) => stripTerminalSequences(card.render(width).join('\n'))
const click = (overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: 'click', button: 'left', x: 1, y: 0, screenX: 1, screenY: 0, width: 100, height: 5, shift: false, alt: false, ctrl: false, ...overrides,
})

describe('pi-style tool cards', () => {
  it('advertises keyboard expansion everywhere and scopes mouse input to fullscreen', () => {
    expect(output(new ToolCard(tool(), options))).toContain('Show details · ctrl+o')
    expect(output(new ToolCard(tool(), options))).not.toContain('click')
    expect(HELP_LINES.find(line => line.startsWith('Ctrl+O:'))).not.toContain('click')
    expect(HELP_LINES.some(line => line.startsWith('Fullscreen only:') && line.includes('first line of a tool card'))).toBe(true)
  })

  it('describes the preview ceiling instead of promising further expansion for huge replacements', () => {
    const oldText = Array.from({ length: 5000 }, (_, index) => 'OLD_' + index).join('\n')
    const newText = Array.from({ length: 5000 }, (_, index) => 'NEW_' + index).join('\n')
    const card = new ToolCard(tool({ name: 'edit', diffs: [{ path: 'big.ts', oldText, newText }], result: undefined }), { ...options, toolsExpanded: true })
    const text = output(card, 140)
    expect(text).toContain('OLD_0')
    expect(text).toContain('NEW_0')
    expect(text).toContain('preview limit')
    expect(text).not.toContain('ctrl+o to expand')
    expect(card.render(140).length).toBeLessThanOrEqual(2003)
  })

  it.each(['bash', 'pwsh'])('bounds multiline %s titles and reveals the original command only when expanded', name => {
    const command = ["cat <<'EOF'", ...Array.from({ length: 1000 }, (_, index) => 'COMMAND_ROW_' + index), 'EOF'].join('\n')
    const card = new ToolCard(tool({ name, args: JSON.stringify({ command }), result: undefined }), options)
    const title = card.render(120)[0]
    expect(output(card, 120)).toContain('1001 more command lines')
    expect(output(card, 120)).not.toContain('COMMAND_ROW_999')
    expect(card.render(120).length).toBeLessThan(6)
    card.setExpanded(true)
    expect(card.render(120)[0]).toBe(title)
    expect(output(card, 120)).toContain('COMMAND_ROW_999')
    expect(output(card, 120)).toContain('EOF')
  })

  it('bounds long single-line commands, metadata, paths and search patterns', () => {
    const command = 'x'.repeat(20000)
    const card = new ToolCard(tool({ name: 'bash', args: JSON.stringify({ command, description: 'd'.repeat(20000), workdir: 'w'.repeat(20000) }), result: undefined }), options)
    expect(card.render(100).length).toBeLessThan(10)
    expect(output(card)).not.toContain('x'.repeat(121))
    expect(output(card)).not.toContain('d'.repeat(161))
    const path = '/deep/'.repeat(2000) + 'distinct-file.ts'
    const read = new ToolCard(tool({ args: JSON.stringify({ file_path: path }) }), options)
    expect(output(read)).toContain('distinct-file.ts')
    expect(read.render(100).length).toBeLessThan(6)
    const search = new ToolCard(tool({ name: 'grep', args: JSON.stringify({ path, pattern: 'pattern'.repeat(2000) }), result: undefined }), options)
    expect(search.render(100).length).toBeLessThan(7)
    expect(toolLabel(path, 160, 'end').length).toBeLessThanOrEqual(160)
  })

  it.each(['description', 'workdir', 'sandbox_permissions'])('escapes C1 in the PTC %s label', field => {
    const value = 'C1_' + String.fromCharCode(0x9b) + '31m_' + String.fromCharCode(0x9d) + '52;c;DATA' + String.fromCharCode(0x9c)
    const card = new ToolCard(tool({ name: 'run_code', args: JSON.stringify({ code: 'return 1', [field]: value }), result: undefined }), options)
    const raw = card.render(140).join('\n')
    for (const code of [0x9b, 0x9d, 0x9c]) expect(raw).not.toContain(String.fromCharCode(code))
    expect(raw).toContain('\\x9b31m')
  })

  it('keeps deletion and addition samples visible for a bounded whole-file rewrite', () => {
    const oldText = Array.from({ length: 500 }, (_, index) => 'OLD_' + index).join('\n')
    const newText = Array.from({ length: 500 }, (_, index) => 'NEW_' + index).join('\n')
    const card = new ToolCard(tool({ name: 'edit', diffs: [{ path: 'big.ts', oldText, newText }], result: undefined }), options)
    const text = output(card, 140)
    expect(text).toContain('1 - OLD_0')
    expect(text).toContain('1 + NEW_0')
    expect(text).toContain('removed lines omitted')
    expect(text).toContain('added lines omitted')
    expect(card.render(140).length).toBeLessThanOrEqual(65)
    card.setExpanded(true)
    expect(output(card, 140)).toContain('OLD_499')
    expect(output(card, 140)).toContain('NEW_499')
  })

  it('keeps successful reads collapsed, then shows the Host result without rereading files', () => {
    const card = new ToolCard(tool({ args: '{"file_path":"missing-file.ts","offset":3,"limit":10}' }), options)
    expect(output(card)).toContain('Read missing-file.ts:3-12')
    expect(output(card)).not.toContain('READ_CONTENT')
    expect(card.handleMouse(click())).toEqual({ handled: true })
    expect(output(card)).toContain('READ_CONTENT')
    card.handleMouse(click())
    expect(output(card)).not.toContain('READ_CONTENT')
  })

  it('preserves leading indentation in an expanded read result', () => {
    const card = new ToolCard(tool({ result: '    return value\nnext line' }), { ...options, toolsExpanded: true })
    expect(card.render(100).find(line => line.includes('return value'))).toMatch(/^ {2}└ {5}return value/u)
  })

  it('keeps read errors visible while collapsed', () => {
    const text = output(new ToolCard(tool({ isError: true, result: 'Permission denied' }), options))
    expect(text).toContain('Permission denied')
    expect(text).toContain('└ error')
    expect(text).not.toContain('to expand')
  })

  it('shows the actual shell command, retains semantic options and keeps five output lines from the end', () => {
    const result = Array.from({ length: 20 }, (_, i) => 'OUT_' + i).join('\n')
    const card = new ToolCard(tool({ name: 'bash', args: JSON.stringify({ command: 'pnpm test', description: 'Run tests', workdir: 'pkg', timeoutMs: 1500, run_in_background: true, sandbox_permissions: 'workspace-write' }), result }), options)
    const collapsed = output(card)
    expect(collapsed).toContain('Ran pnpm test')
    expect(collapsed).toContain('Run tests')
    expect(collapsed).toContain('workdir pkg')
    expect(collapsed).toContain('timeout 1500ms')
    expect(collapsed).toContain('background')
    expect(collapsed).toContain('sandbox workspace-write')
    expect(collapsed).toContain('OUT_15')
    expect(collapsed).toContain('OUT_19')
    expect(collapsed).not.toContain('OUT_14')
    expect(collapsed).not.toContain('└ done')
    card.setExpanded(true)
    expect(output(card)).toContain('OUT_0')
  })

  it('uses visual rows rather than logical lines when folding long CJK output', () => {
    const text = '你好世界'.repeat(20) + '\nTAIL'
    const preview = new ToolOutput(text, palette, false, 5, 'end')
    const lines = preview.render(10)
    const all = new Text(text, 0, 0).render(10)
    expect(lines.slice(0, 5)).toEqual(all.slice(-5))
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(lines.join('\n')).toContain('earlier')
    expect(lines.join('\n')).toContain('TAIL')
  })

  it('does not accumulate expansion hints across renders and resizes', () => {
    const preview = new ToolOutput('row\n'.repeat(30), palette, true)
    const first = preview.render(80)
    expect(preview.render(80)).toEqual(first)
    preview.render(20)
    expect(preview.render(80)).toEqual(first)
    expect(first.join('\n')).not.toContain('ctrl+o')
  })

  it('folds generic and MCP results without opaque args/result labels', () => {
    const result = Array.from({ length: 20 }, (_, i) => 'MODEL_' + i).join('\n')
    const card = new ToolCard(tool({ name: 'mcp__idea__search_symbol', args: '{"q":"Service"}', result }), options)
    expect(output(card)).toContain('MCP idea/search_symbol')
    expect(output(card)).toContain('q=Service')
    expect(output(card)).toContain('MODEL_9')
    expect(output(card)).not.toContain('MODEL_10')
    expect(output(card)).not.toContain('├ args')
    expect(output(card)).not.toContain('├ result')
    card.handleMouse(click())
    expect(output(card)).toContain('MODEL_19')
  })

  it('names a search by its pattern even when its scope path is present', () => {
    const text = output(new ToolCard(tool({ name: 'grep', args: '{"pattern":"TODO","path":"src"}' }), options))
    expect(text).toContain('Search "TODO" src')
  })

  it('keeps local expansion through pending, partial and final updates', () => {
    const block = tool({ pending: true, result: undefined })
    const card = new ToolCard(block, options)
    const head = card.render(100)[0]
    card.handleMouse(click())
    card.update({ ...block, result: 'PARTIAL' })
    expect(output(card)).toContain('PARTIAL')
    expect(output(card)).toContain('running')
    card.update({ ...block, pending: false, result: 'FINAL' })
    expect(card.render(100)[0]).toBe(head)
    expect(output(card)).toContain('FINAL')
    expect(output(card)).not.toContain('running')
  })

  it('ignores right clicks, modified clicks, body clicks and wheel events', () => {
    const card = new ToolCard(tool(), options)
    for (const event of [click({ button: 'right' }), click({ ctrl: true }), click({ shift: true }), click({ y: 2 }), click({ type: 'wheel' })]) {
      expect(card.handleMouse(event)).toBeUndefined()
      expect(output(card)).not.toContain('READ_CONTENT')
    }
    card.setExpanded(true)
    output(card)
    expect(card.handleMouse(click({ y: 1 }))).toBeUndefined()
  })

  it('preserves per-card clicks through the transcript memo and global expansion without recreating other cards', () => {
    const renderer = new TranscriptRenderer(options)
    const a = tool(), b = tool({ callId: 't2', result: 'SECOND_CONTENT' })
    renderer.set([], [a, b])
    const [first, , second] = renderer.container.children
    first!.handleMouse!(click())
    expect(renderer.container.render(100).join('\n')).toContain('READ_CONTENT')
    expect(renderer.container.render(100).join('\n')).not.toContain('SECOND_CONTENT')
    renderer.set([], [{ ...a, result: 'UPDATED' }, b])
    expect(renderer.container.children[0]).toBe(first)
    expect(renderer.container.render(100).join('\n')).toContain('UPDATED')
    renderer.toggleToolPreviews()
    expect(renderer.container.children[0]).toBe(first)
    expect(renderer.container.children[2]).toBe(second)
    expect(renderer.container.render(100).join('\n')).toContain('SECOND_CONTENT')
    renderer.toggleToolPreviews()
    expect(renderer.container.render(100).join('\n')).not.toContain('SECOND_CONTENT')
  })

  it('shows the real changed line in large applied diffs with surrounding context and line numbers', () => {
    const before = Array.from({ length: 1000 }, (_, i) => 'LINE_' + (i + 1))
    const after = [...before]
    after[899] = 'CHANGED_900'
    const card = new ToolCard(tool({ name: 'edit', args: '{"file_path":"large.ts"}', diffs: [{ path: 'large.ts', oldText: before.join('\n'), newText: after.join('\n') }], result: 'redundant success message' }), options)
    const text = output(card)
    expect(text).toContain('900 - LINE_900')
    expect(text).toContain('900 + CHANGED_900')
    expect(text).toContain('897   LINE_897')
    expect(text).toContain('903   LINE_903')
    expect(text).not.toContain('redundant success message')
    expect(card.render(100).length).toBeLessThan(15)
  })

  it('uses bounded previews without hiding the tail diagnostics of large output', () => {
    const card = new ToolCard(tool({ name: 'bash', args: '{"command":"build"}', result: 'prefix\n'.repeat(20000) + 'FINAL_DIAGNOSTIC' }), options)
    expect(output(card)).toContain('FINAL_DIAGNOSTIC')
    expect(output(card)).toContain('chars omitted')
    expect(card.render(100).length).toBeLessThan(15)
  })

  it('bounds expanded write previews and keeps long diff lines within a folded viewport', () => {
    const write = new ToolCard(tool({ name: 'write', args: JSON.stringify({ file_path: 'large.txt', content: 'x'.repeat(100000) }) }), { ...options, toolsExpanded: true })
    expect(output(write)).toContain('content omitted by preview limit')
    expect(write.render(100).length).toBeLessThan(1000)
    const edit = new ToolCard(tool({ name: 'edit', diffs: [{ path: 'large.txt', oldText: 'before', newText: 'y'.repeat(100000) }] }), options)
    expect(edit.render(40).length).toBeLessThan(10)
    expect(output(edit, 40)).toContain('long diff lines clipped')
    edit.setExpanded(true)
    expect(output(edit)).toContain('diff content omitted by preview limit')
  })

  it('escapes terminal control sequences in paths and source and strips them from output', () => {
    const attack = '\x1b]52;c;clipboard-data\x07'
    const card = new ToolCard(tool({ args: JSON.stringify({ file_path: 'file' + attack }), isError: true, result: attack + 'ERROR_TEXT' }), options)
    const raw = card.render(120).join('\n')
    expect(raw).not.toContain(attack)
    expect(raw).toContain('ERROR_TEXT')
    expect(literalToolText(attack)).toContain('\\x1b]52')
  })

  it('keeps malformed argument diagnostics and partial code execution results readable', () => {
    const card = new ToolCard(tool({ name: 'bash', args: 'not JSON', isError: true, result: 'Invalid args' }), options)
    expect(output(card)).toContain('not JSON')
    expect(output(card)).toContain('Invalid args')
    const code = Array.from({ length: 20 }, (_, i) => 'const item' + i + ' = ' + i).join('\n')
    const ptc = new ToolCard(tool({ name: 'run_code', args: JSON.stringify({ code }), callLines: ['read a.ts'], result: 'result\n'.repeat(20) + 'FINAL_RESULT' }), { ...options, runCodeDisplay: 'compact' })
    expect(output(ptc)).toContain('└ Read a.ts')
    expect(output(ptc)).not.toContain('const item19')
    ptc.setExpanded(true)
    expect(output(ptc)).toContain('const item19')
    expect(output(ptc)).toContain('FINAL_RESULT')
  })
})
