import { formatProgramStatus, type ProgramStatus } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { TAB_STATUS_APP, TabBlockingDialogs, TabStatusReporter, tabActivity, tabProgramStatus, type TabActivity } from '../src/ui/tab-status.js'

describe('tabProgramStatus', () => {
  it('names the program on every state because a report replaces the record', () => {
    const activities: TabActivity[] = [{ phase: 'idle' }, { phase: 'working' }, { phase: 'done' }, { phase: 'error' }]
    for (const activity of activities) expect(tabProgramStatus(activity).app).toBe(TAB_STATUS_APP)
  })

  it('maps the quiet states without a message', () => {
    expect(tabProgramStatus({ phase: 'idle' })).toEqual({ state: 'idle', app: TAB_STATUS_APP })
    expect(tabProgramStatus({ phase: 'working' })).toEqual({ state: 'working', app: TAB_STATUS_APP })
    expect(tabProgramStatus({ phase: 'done' })).toEqual({ state: 'done', app: TAB_STATUS_APP })
  })

  it('tells a failed turn apart from a finished one', () => {
    expect(tabProgramStatus({ phase: 'error' })).toEqual({
      state: 'error', app: TAB_STATUS_APP, message: 'Turn failed',
    })
  })

  it('keeps the blocked kind and why the program waits', () => {
    expect(tabProgramStatus({ phase: 'blocked', kind: 'permission' })).toEqual({
      state: 'blocked', app: TAB_STATUS_APP, kind: 'permission', message: 'waiting:permission',
    })
    expect(tabProgramStatus({ phase: 'blocked', kind: 'question' })).toEqual({
      state: 'blocked', app: TAB_STATUS_APP, kind: 'question', message: 'waiting:question',
    })
  })

  it('encodes a record the terminal parses as one complete report', () => {
    const sequence = formatProgramStatus(tabProgramStatus({ phase: 'blocked', kind: 'permission' }))
    expect(sequence.startsWith('\x1b]7501;')).toBe(true)
    expect(sequence.endsWith('\x1b\\')).toBe(true)
    expect(sequence).toContain('state=blocked')
    expect(sequence).toContain('kind=permission')
    expect(sequence).toContain('app=' + TAB_STATUS_APP)
    expect(sequence).toContain('msg=' + Buffer.from('waiting:permission').toString('base64'))
  })
})

describe('tabActivity', () => {
  it('is idle before anything runs', () => {
    expect(tabActivity({ running: false })).toEqual({ phase: 'idle' })
  })

  it('is working while the Agent runs', () => {
    expect(tabActivity({ running: true })).toEqual({ phase: 'working' })
  })

  it('lets a dialog outrank a running turn', () => {
    expect(tabActivity({ running: true, blocked: 'permission' })).toEqual({ phase: 'blocked', kind: 'permission' })
    expect(tabActivity({ running: true, blocked: 'question' })).toEqual({ phase: 'blocked', kind: 'question' })
  })

  it('holds a settled outcome until the next turn starts', () => {
    expect(tabActivity({ running: false, outcome: 'done' })).toEqual({ phase: 'done' })
    expect(tabActivity({ running: false, outcome: 'error' })).toEqual({ phase: 'error' })
    expect(tabActivity({ running: true, outcome: 'done' })).toEqual({ phase: 'working' })
  })
})

describe('TabBlockingDialogs', () => {
  it('keeps the latest question when an older question closes out of order', () => {
    const dialogs = new TabBlockingDialogs()
    const closeOlderQuestion = dialogs.open('question')
    const closeApproval = dialogs.open('permission')
    const closeLatestQuestion = dialogs.open('question')

    closeOlderQuestion()
    expect(dialogs.current).toBe('question')
    closeLatestQuestion()
    expect(dialogs.current).toBe('permission')
    closeApproval()
    expect(dialogs.current).toBeUndefined()
  })

  it('ignores a close from the previous session after clearing its dialogs', () => {
    const dialogs = new TabBlockingDialogs()
    const closePrevious = dialogs.open('permission')
    dialogs.clear()
    const closeCurrent = dialogs.open('permission')

    closePrevious()
    expect(dialogs.current).toBe('permission')
    closeCurrent()
    expect(dialogs.current).toBeUndefined()
  })
})

describe('TabStatusReporter', () => {
  const recorder = (): { readonly terminal: { setProgramStatus(status: ProgramStatus): void }; readonly written: ProgramStatus[] } => {
    const written: ProgramStatus[] = []
    return { terminal: { setProgramStatus: status => { written.push(status) } }, written }
  }

  it('writes the first record', () => {
    const { terminal, written } = recorder()
    const reporter = new TabStatusReporter(terminal)
    expect(reporter.report({ phase: 'idle' })).toBe(true)
    expect(written).toEqual([{ state: 'idle', app: TAB_STATUS_APP }])
  })

  it('drops a repeat so a repainting status row does not rewrite terminal state', () => {
    const { terminal, written } = recorder()
    const reporter = new TabStatusReporter(terminal)
    reporter.report({ phase: 'working' })
    expect(reporter.report({ phase: 'working' })).toBe(false)
    expect(written).toHaveLength(1)
  })

  it('writes again when the state changes and when it returns', () => {
    const { terminal, written } = recorder()
    const reporter = new TabStatusReporter(terminal)
    reporter.report({ phase: 'working' })
    reporter.report({ phase: 'done' })
    reporter.report({ phase: 'working' })
    expect(written.map(status => status.state)).toEqual(['working', 'done', 'working'])
  })

  it('treats a different blocked kind as a different record', () => {
    const { terminal, written } = recorder()
    const reporter = new TabStatusReporter(terminal)
    reporter.report({ phase: 'blocked', kind: 'permission' })
    reporter.report({ phase: 'blocked', kind: 'question' })
    expect(written.map(status => status.kind)).toEqual(['permission', 'question'])
  })
})
