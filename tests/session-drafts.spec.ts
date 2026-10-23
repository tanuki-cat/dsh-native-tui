import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PendingAttachment } from '../src/runtime/attachments.js'
import { SessionDrafts } from '../src/ui/session-drafts.js'
import { PromptEditor } from '../src/ui/prompt-editor.js'
import { createPalette, editorTheme } from '../src/ui/theme.js'

const attachment = (label: string): PendingAttachment => ({ label, kind: 'file', block: { type: 'text', text: label } })
const session = (id: string, cwd = '/work/a', preset = 'ptc'): Session => Session.create(SessionId(id), [], {
  ...Session.create(SessionId(id)).header, cwd, agentPreset: preset,
})

describe('session drafts', () => {
  it('restores expanded multiline paste content after the editor discards its paste markers', () => {
    const editor = new PromptEditor({ terminal: { rows: 30 }, requestRender: () => {} } as never, editorTheme(createPalette('plain')))
    const text = 'large paste '.repeat(500) + '\nlast line'
    editor.handleInput('\x1b[200~' + text + '\x1b[201~')
    expect(editor.getExpandedText()).toBe(text)
    expect(editor.getText()).not.toBe(text)
    const drafts = new SessionDrafts()
    const a = session('paste')
    drafts.save(a, { text: editor.getExpandedText(), attachments: [] }, '/work/a')
    editor.setText('another session')
    editor.setText(drafts.restore(a.id).text)
    let submitted = ''
    editor.onSubmit = value => { submitted = value }
    editor.handleInput('\r')
    expect(submitted).toBe(text)
  })

  it('restores each session text and attachments without mixing them', () => {
    const drafts = new SessionDrafts()
    const a = session('a'), b = session('b')
    drafts.save(a, { text: 'draft A\nnext line', attachments: [attachment('A')] }, '/work/a')
    drafts.save(b, { text: 'draft B', attachments: [attachment('B')] }, '/work/a')
    expect(drafts.restore(a.id)).toEqual({ text: 'draft A\nnext line', attachments: [attachment('A')] })
    expect(drafts.restore(b.id)).toEqual({ text: 'draft B', attachments: [attachment('B')] })
    expect(drafts.restore(SessionId('new'))).toEqual({ text: '', attachments: [] })
  })

  it('keeps attachment ownership when an in-flight command finishes after switching', () => {
    const drafts = new SessionDrafts()
    const a = session('a'), b = session('b')
    const pending: PendingAttachment[] = []
    drafts.save(a, { text: 'A', attachments: pending }, '/work/a')
    drafts.save(b, { text: 'B', attachments: [] }, '/work/a')
    pending.push(attachment('late A'))
    expect(drafts.restore(a.id).attachments).toEqual([attachment('late A')])
    expect(drafts.restore(b.id).attachments).toEqual([])
    drafts.restore(a.id).attachments.splice(0)
    expect(drafts.restore(a.id).attachments).toEqual([])
  })

  it('returns the first matching blank without crossing workspaces or presets', () => {
    const drafts = new SessionDrafts()
    const a = session('a'), b = session('b', '/work/b'), c = session('c', '/work/a', 'minimal')
    for (const value of [a, b, c]) drafts.save(value, { text: value.id, attachments: [] }, '/fallback')
    expect(drafts.findBlank('/work/a/.', 'ptc')).toBe(a.id)
    expect(drafts.findBlank('/work/b', 'ptc')).toBe(b.id)
    expect(drafts.findBlank('/work/a', 'minimal')).toBe(c.id)
    expect(drafts.findBlank('/work/a', 'standard')).toBeUndefined()
  })

  it('excludes archived blanks without discarding their drafts', () => {
    const drafts = new SessionDrafts()
    const a = session('a')
    drafts.save(a, { text: 'keep me', attachments: [] }, '/work/a')
    expect(drafts.findBlank('/work/a', 'ptc', [a.id])).toBeUndefined()
    expect(drafts.restore(a.id).text).toBe('keep me')
    expect(drafts.findBlank('/work/a', 'ptc')).toBe(a.id)
  })

  it('does not reuse a session after its first turn even if its retained history is empty', () => {
    const drafts = new SessionDrafts()
    const a = session('a')
    const events = [{ type: 'turn/start' }]
    const view = { ...a, id: a.id, header: a.header, snapshotEvents: () => events } as unknown as Session
    drafts.save(view, { text: '', attachments: [] }, '/work/a')
    events.splice(0)
    drafts.save(view, { text: '', attachments: [] }, '/work/a')
    expect(drafts.findBlank('/work/a', 'ptc')).toBeUndefined()
  })

  it('clears a submitted draft and restores empty prompts with no shared attachment array', () => {
    const drafts = new SessionDrafts()
    const a = session('a')
    drafts.save(a, { text: 'sent', attachments: [attachment('sent')] }, '/work/a')
    drafts.save(a, { text: '', attachments: [] }, '/work/a')
    expect(drafts.restore(a.id)).toEqual({ text: '', attachments: [] })
    const unknown = drafts.restore(SessionId('unknown'))
    unknown.attachments.push(attachment('isolated'))
    expect(drafts.restore(SessionId('other')).attachments).toEqual([])
  })
})
