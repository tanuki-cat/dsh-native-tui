import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { showChoice } from '../src/ui/dialogs.js'
import { createPalette } from '../src/ui/theme.js'

describe('dialog frame', () => {
  it('renders a bounded opaque surface for a multiline title', async () => {
    let rendered: ReturnType<{ render(width: number): string[] }['render']> = []
    const controller = new AbortController()
    const promise = showChoice({
      showOverlay(component: { render(width: number): string[] }) {
        rendered = component.render(50)
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Approval required · run_code\n' + 'reason '.repeat(30), [
      { value: 'allow', label: 'Allow once', description: 'Approve this exact request only' },
      { value: 'reject', label: 'Reject', description: 'Fail the request closed' },
    ], 'Enter selects · Esc cancels', controller.signal)
    expect(rendered[0]?.startsWith('┌')).toBe(true)
    expect(rendered.at(-1)?.startsWith('└')).toBe(true)
    expect(rendered.every(line => visibleWidth(line) <= 50)).toBe(true)
    expect(rendered.every(line => !line.includes('\n'))).toBe(true)
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
  })
})
