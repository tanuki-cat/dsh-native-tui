import { describe, expect, it } from 'vitest'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { renderTranscriptBlock } from '../src/ui/transcript-render.js'
import { AssistantMessage } from '../src/ui/assistant-message.js'
import { createPalette, markdownTheme } from '../src/ui/theme.js'
import { showChoice, showMarkdownPreview, showTextPager } from '../src/ui/dialogs.js'
import type { TranscriptBlock } from '../src/ui/transcript.js'

const escape = String.fromCharCode(27)
const payload = 'before' + escape + ']52;c;UFJPT0Y=' + String.fromCharCode(7) + escape + '[2Jafter'
const palette = createPalette('plain')
const options = { showReasoning: true, maxEntries: 100, palette, markdown: markdownTheme(palette) }

function terminalOutput(block: TranscriptBlock): string {
  const writes: string[] = []
  const terminal = {
    columns: 100, rows: 30, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write(text: string) { writes.push(text) },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  }
  const tui = new TuiMainScreen(terminal as never, false)
  try {
    tui.addChild(renderTranscriptBlock(block, options))
    tui.start()
    tui.renderNow()
    return writes.join('')
  } finally { tui.stop() }
}

function overlayHarness() {
  let overlay: { render(width: number): string[]; handleInput?(data: string): void } | undefined
  let listener: ((data: string) => unknown) | undefined
  const tui = {
    requestRender() {},
    showOverlay(component: NonNullable<typeof overlay>) { overlay = component; return { hide() {}, focus() {} } },
    addInputListener(callback: NonNullable<typeof listener>) { listener = callback; return () => { listener = undefined } },
  }
  return { tui, render: () => overlay!.render(100).join('\n'), select: () => overlay?.handleInput?.('\r'), close: () => { if (listener) listener(escape); else overlay?.handleInput?.(escape) } }
}

describe('untrusted terminal text', () => {
  const blocks: TranscriptBlock[] = [
    { kind: 'user', text: payload },
    { kind: 'assistant', text: payload, reasoning: payload, live: false },
    { kind: 'context', label: payload, text: payload },
    { kind: 'notice', tone: 'info', text: payload },
    { kind: 'compaction', compactionId: 'c', state: 'error', summary: payload, error: payload },
    { kind: 'tool', callId: 't', name: 'bash', args: '{}', pending: false, result: payload },
  ]
  it.each(blocks)('does not deliver OSC instructions from $kind to the terminal', block => {
    const output = terminalOutput(block)
    expect(output).not.toContain(escape + ']52;')
    expect(output).not.toContain(escape + '[2Jafter')
    expect(output).toContain('before')
    expect(output).toContain('after')
  })

  it('cleans streaming updates without dropping Markdown or trusted styling', () => {
    const dark = createPalette('dark')
    const component = new AssistantMessage({ kind: 'assistant', text: '**initial**', live: true }, {
      ...options, palette: dark, markdown: markdownTheme(dark),
    })
    component.render(80)
    component.update({ kind: 'assistant', text: '**bold** ' + payload, live: true })
    const rendered = component.render(80).join('\n')
    expect(rendered).not.toContain(escape + ']52;')
    expect(rendered).not.toContain(escape + '[2J')
    expect(rendered).toContain('bold')
    expect(rendered).toContain(escape + '[1m')
  })

  it('cleans choice titles and labels without changing selected values', async () => {
    const h = overlayHarness()
    const pending = showChoice(h.tui as never, palette, payload, [{ value: 'original', label: payload, description: payload }], 'Enter')
    try {
      expect(h.render()).not.toContain(escape)
      h.select()
      expect(await pending).toBe('original')
    } finally { h.close(); await pending }
  })

  it.each(['text', 'markdown'])('cleans %s pager input', async kind => {
    const h = overlayHarness()
    const pending = kind === 'text'
      ? showTextPager(h.tui as never, palette, payload, payload)
      : showMarkdownPreview(h.tui as never, palette, payload, '**bold** ' + payload)
    try { expect(h.render()).not.toContain(escape) }
    finally { h.close(); await pending }
  })
})
