import { describe, expect, it, vi } from 'vitest'
import { enqueuePrompt, submitDraft } from '../src/ui/prompt-submission.js'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'
import type { PendingAttachment } from '../src/runtime/attachments.js'

const attachment = (id: string): PendingAttachment => ({ id, block: { type: 'text', text: id } } as unknown as PendingAttachment)
describe('native Host input admission', () => {
  it('restores the real pi-tui buffer that was cleared before onSubmit', () => {
    const editor = new PromptEditor({ terminal: { rows: 30 }, requestRender: vi.fn() } as never, editorTheme(createPalette('plain')))
    editor.onSubmit = text => { submitDraft(text, editor, () => false) }
    editor.setText('retry this message'); editor.handleInput('\r')
    expect(editor.getText()).toBe('retry this message')
  })
  it.each(['idle', 'running'] as const)('preserves text and attachments when the %s Agent rejects admission', status => {
    let draft = 'retry me'
    const pending = [attachment('a')]
    const refuse = vi.fn(() => { throw new Error('rejected') })
    const editor = { getText: () => draft, setText: (value: string) => { draft = value } }
    expect(() => submitDraft(draft, editor, () => enqueuePrompt({ status, followup: refuse, steer: refuse }, draft, pending))).toThrow('rejected')
    expect(draft).toBe('retry me'); expect(pending).toHaveLength(1)
  })
  it.each(['idle', 'running'] as const)('commits the accepted %s draft once and uses the proper queue', status => {
    let draft = 'send me'
    const pending = [attachment('a')], followup = vi.fn(), steer = vi.fn()
    const editor = { getText: () => draft, setText: (value: string) => { draft = value } }
    expect(submitDraft(draft, editor, () => enqueuePrompt({ status, followup, steer }, draft, pending))).toBe(true)
    expect(status === 'running' ? steer : followup).toHaveBeenCalledTimes(1)
    expect(draft).toBe(''); expect(pending).toHaveLength(0)
  })
  it('does not consume attachments or a newer edit added during synchronous Host callbacks', () => {
    let draft = 'original'
    const pending = [attachment('a')], newer = attachment('b')
    const editor = { getText: () => draft, setText: (value: string) => { draft = value } }
    submitDraft(draft, editor, () => enqueuePrompt({ status: 'idle', followup: () => { draft = 'new draft'; pending.push(newer) }, steer: vi.fn() }, 'original', pending))
    expect(draft).toBe('new draft'); expect(pending).toEqual([newer])
  })
  it('does not accept an empty submission but supports attachment-only messages', () => {
    const agent = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    expect(enqueuePrompt(agent, ' ', [])).toBe(false)
    expect(enqueuePrompt(agent, '', [attachment('a')])).toBe(true)
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })
})
