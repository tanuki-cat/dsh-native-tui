import { describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { showApproval } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

type Overlay = { render(width: number): string[]; handleInput(data: string): void }
function harness(onShow?: () => void) {
  const overlays: Overlay[] = []
  const hide = vi.fn()
  const tui = { terminal: { rows: 18 }, requestRender: vi.fn(), showOverlay(component: Overlay) {
    overlays.push(component)
    onShow?.()
    return { hide, focus() {} }
  } }
  return { tui, overlays, hide }
}
const palette = createPalette('plain')
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
function request(controller: AbortController, command = 'git status', type = 'tool/ptc-dispatch-start') {
  return {
    toolName: 'bash', callId: 'wanted', signal: controller.signal, reason: 'Reason '.repeat(400),
    agent: { session: { header: { cwd: '/work' }, snapshotEvents: () => [{ type,
      data: { name: 'bash', callId: 'wanted', subCallId: 'wanted', arguments: { description: 'Descriptive label', command } },
    }] } },
  } as unknown as Parameters<typeof showApproval>[2]
}
function details(overlay: Overlay) { for (let i = 0; i < 3; i++) overlay.handleInput('\x1b[B'); overlay.handleInput('\r') }

describe('approval previews and details', () => {
  it('numbers actions and requires Enter after a number focuses the selection', async () => {
    const h = harness(), controller = new AbortController()
    const running = showApproval(h.tui as never, palette, request(controller, 'git status'))
    const text = h.overlays[0]!.render(80).join('\n')
    expect(text).toContain('1. Allow once')
    expect(text).toContain('2. Reject')
    expect(text).toContain('3. Cancel')
    let settled = false
    void running.then(() => { settled = true })
    h.overlays[0]!.handleInput('2')
    await flush()
    expect(settled).toBe(false)
    h.overlays[0]!.handleInput('\r')
    expect(await running).toBe('rejected')
  })
  it.each(['tool/call', 'tool/ptc-dispatch-start'])('shows the actual %s command while keeping all choices visible', async type => {
    const h = harness(), controller = new AbortController()
    const running = showApproval(h.tui as never, palette, request(controller, 'git status', type))
    const lines = h.overlays[0]!.render(40), text = lines.join('\n')
    expect(text).toContain('bash git status')
    expect(text).not.toContain('Descriptive label')
    for (const label of ['Allow once', 'Reject', 'Cancel']) expect(text).toContain(label)
    expect(lines.length).toBeLessThanOrEqual(Math.floor(18 * 0.8))
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
    h.overlays[0]!.handleInput('\x1b')
    expect(await running).toBe('cancelled')
  })

  it('inspects the full long request, returns to approval, then rejects without implicit approval', async () => {
    const h = harness(), controller = new AbortController()
    const command = 'echo ' + 'x'.repeat(3000) + '; echo ORIGINAL_SUFFIX'
    let settled = false
    const running = showApproval(h.tui as never, palette, request(controller, command))
    void running.then(() => { settled = true })
    details(h.overlays[0]!); await flush()
    const viewer = h.overlays[1]!
    let seen = ''
    for (let i = 0; i < 40 && !seen.includes('ORIGINAL_SUFFIX'); i++) {
      const rendered = viewer.render(i % 2 === 0 ? 40 : 80)
      expect(rendered.length).toBeLessThanOrEqual(Math.floor(18 * 0.8))
      expect(rendered.some(line => line.includes('Esc closes'))).toBe(true)
      seen += rendered.join('\n')
      viewer.handleInput('\x1b[6~')
    }
    expect(seen).toContain('ORIGINAL_SUFFIX')
    expect(settled).toBe(false)
    viewer.handleInput('\x1b'); await flush()
    expect(h.overlays).toHaveLength(3)
    h.overlays[2]!.handleInput('\x1b[B'); h.overlays[2]!.handleInput('\r')
    expect(await running).toBe('rejected')
    expect(h.hide).toHaveBeenCalledTimes(3)
  })

  it('shows the skill name in an approval preview', async () => {
    const h = harness(), controller = new AbortController()
    const req = { ...request(controller), toolName: 'skill', agent: { session: {
      header: { cwd: '/work' }, snapshotEvents: () => [{ type: 'tool/ptc-dispatch-start', data: {
        name: 'skill', subCallId: 'wanted', arguments: { name: 'daily-log-writer' },
      } }],
    } } } as unknown as Parameters<typeof showApproval>[2]
    const running = showApproval(h.tui as never, palette, req)
    expect(h.overlays[0]!.render(80).join('\n')).toContain('skill daily-log-writer')
    controller.abort()
    expect(await running).toBe('cancelled')
  })

  it('cancels while viewing details and does not reopen approval', async () => {
    const h = harness(), controller = new AbortController()
    const running = showApproval(h.tui as never, palette, request(controller))
    details(h.overlays[0]!); await flush()
    controller.abort()
    expect(await running).toBe('cancelled')
    expect(h.overlays).toHaveLength(2)
    expect(h.hide).toHaveBeenCalledTimes(2)
  })

  it('does not lose a cancellation delivered during overlay creation', async () => {
    const controller = new AbortController(), h = harness(() => controller.abort())
    expect(await showApproval(h.tui as never, palette, request(controller))).toBe('cancelled')
    expect(h.hide).toHaveBeenCalledOnce()
  })

  it('renders terminal controls as literal data', async () => {
    const h = harness(), controller = new AbortController()
    const running = showApproval(h.tui as never, palette, request(controller, 'echo ' + String.fromCharCode(27) + '[2J'))
    expect(h.overlays[0]!.render(80).join('\n')).not.toContain(String.fromCharCode(27))
    controller.abort(); await running
  })
})
