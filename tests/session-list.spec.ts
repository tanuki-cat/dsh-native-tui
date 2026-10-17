import { describe, expect, it } from 'vitest'
import { isNativeTuiSessionId, ownStoredSessions, selectListedSessions } from '../src/runtime/session-list.js'

const session = (id: string, createdAt: number): { id: string; createdAt: number } => ({ id, createdAt })

describe('selectListedSessions', () => {
  it('orders newest first because persistence promises no order', () => {
    const rows = [session('old', 1), session('newest', 3), session('middle', 2)]
    const selection = selectListedSessions(rows, 'absent', 10)
    expect(selection.shown.map(row => row.id)).toEqual(['newest', 'middle', 'old'])
    expect(selection.hidden).toBe(0)
  })

  it('pins the active session first even when older sessions exist', () => {
    const rows = [session('newest', 30), session('current', 10), session('older', 1)]
    const selection = selectListedSessions(rows, 'current', 10)
    expect(selection.shown.map(row => row.id)).toEqual(['current', 'newest', 'older'])
  })

  it('keeps the active session when truncating a large store', () => {
    const rows = Array.from({ length: 40 }, (_, index) => session('session-' + String(index), index))
    const selection = selectListedSessions(rows, 'session-0', 12)
    expect(selection.shown).toHaveLength(12)
    expect(selection.shown[0]?.id).toBe('session-0')
    expect(selection.hidden).toBe(28)
  })

  it('drops the oldest sessions first when the active session is absent', () => {
    const rows = Array.from({ length: 40 }, (_, index) => session('session-' + String(index), index))
    const selection = selectListedSessions(rows, 'not-stored', 12)
    expect(selection.shown.map(row => row.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => 'session-' + String(39 - index)),
    )
    expect(selection.hidden).toBe(28)
  })

  it('reports an empty store without inventing rows', () => {
    expect(selectListedSessions([], 'current', 12)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('isNativeTuiSessionId', () => {
  it('recognizes the ids this terminal stamps on its root sessions', () => {
    expect(isNativeTuiSessionId('native-tui-01484b9a-12b2-44e5-802c-f5022731d5e1')).toBe(true)
  })

  it('rejects ids minted by another front door', () => {
    expect(isNativeTuiSessionId('1818a270-f72a-4469-8101-ae9c44044483')).toBe(false)
  })
})

describe('ownStoredSessions', () => {
  const stored = (id: string, extra: { origin?: string } = {}): { id: string; createdAt: number; origin?: string } =>
    ({ id, createdAt: 1, ...extra })

  it('keeps only root sessions created by this terminal', () => {
    const rows = [
      stored('native-tui-aaa'),
      stored('1818a270-f72a-4469-8101-ae9c44044483'),
      stored('dcb2ef18-de21-4aa6-9ee0-703e9df41eb1', { origin: 'subagent' }),
    ]
    expect(ownStoredSessions(rows).map(row => row.id)).toEqual(['native-tui-aaa'])
  })

  it('drops a subagent child even when it carries the terminal prefix', () => {
    const rows = [stored('native-tui-child', { origin: 'subagent' })]
    expect(ownStoredSessions(rows)).toEqual([])
  })

  it('preserves the stored order rather than re-sorting', () => {
    const rows = [stored('native-tui-b'), stored('native-tui-a')]
    expect(ownStoredSessions(rows).map(row => row.id)).toEqual(['native-tui-b', 'native-tui-a'])
  })

  it('returns an empty list when the store holds only foreign sessions', () => {
    expect(ownStoredSessions([stored('aaaaaaaa-1111-2222-3333-444444444444')])).toEqual([])
  })
})
