import { describe, expect, it } from 'vitest'
import { PasteInput } from '../src/ui/paste-input.js'

describe('PasteInput', () => {
  it('unblocks subsequent input when cancelled while an async paste is pending', async () => {
    let resolvePaste!: (value: string) => void
    const delivered: string[] = []
    let renders = 0
    const paste = new PasteInput(
      () => new Promise<string>(resolve => { resolvePaste = resolve }),
      data => { delivered.push(data) },
      () => { renders += 1 },
    )
    paste.handleInput('\x1b[200~image.png\x1b[201~')
    expect(paste.busy).toBe(true)
    paste.cancel()
    expect(paste.busy).toBe(false)
    paste.handleInput('next')
    expect(delivered).toEqual(['next'])
    resolvePaste('stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(delivered).toEqual(['next'])
    expect(renders).toBe(0)
  })
})
