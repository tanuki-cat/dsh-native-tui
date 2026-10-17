import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { showApproval, showChoice, showSearchChoice } from '../src/ui/dialogs.js'
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

  it('maps approval choices and renders the request reason', async () => {
    const run = async (keys: string[]): Promise<{ outcome: string; rendered: string }> => {
      let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
      const promise = showApproval({
        showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
          component = value
          return { hide() {} }
        },
      } as never, createPalette('plain'), {
        toolName: 'run_code',
        callId: 'call-1' as never,
        reason: 'Write outside workspace',
      }, undefined)
      const rendered = component!.render(80).join('\n')
      for (const key of keys) component!.handleInput(key)
      return { outcome: await promise, rendered }
    }
    await expect(run(['\r'])).resolves.toMatchObject({ outcome: 'allowed-once' })
    const rejected = await run(['\x1b[B', '\r'])
    expect(rejected.outcome).toBe('rejected')
    expect(rejected.rendered).toContain('Approval required · run_code')
    expect(rejected.rendered).toContain('Write outside workspace')
    await expect(run(['\x1b'])).resolves.toMatchObject({ outcome: 'cancelled' })
  })

  it('filters a searchable choice list before selecting', async () => {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
    const promise = showSearchChoice({
      showOverlay(value: { render(width: number): string[]; handleInput(data: string): void }) {
        component = value
        return { hide() {} }
      },
    } as never, createPalette('plain'), 'Select model', [
      { value: 'provider/alpha', label: 'Alpha', description: 'fast' },
      { value: 'provider/beta', label: 'Beta', description: 'reasoning' },
    ], 'Type to filter · Enter selects', new AbortController().signal)
    component!.handleInput('bet')
    const filtered = component!.render(84).join('\n')
    expect(filtered).toContain('Beta')
    expect(filtered).not.toContain('Alpha')
    component!.handleInput('\r')
    await expect(promise).resolves.toBe('provider/beta')
  })
})
