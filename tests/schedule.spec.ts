import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleCommand } from '../src/ui/commands/schedule.js'
import { parseScheduleCreate, parseSchedulePatch, parseScheduleTiming } from '../src/ui/commands/schedule-input.js'
import { commandFixture } from './rc1-command-fixture.js'
import { showChoice, showMultilineInput } from '../src/ui/dialogs.js'
vi.mock('../src/ui/dialogs.js', () => ({ showChoice: vi.fn(), showMultilineInput: vi.fn() }))
const row = { id: 'schedule-1', kind: 'after', title: 'task', prompt: 'do task', scheduledAt: '2026-12-01T00:00:00Z',
  target: { kind: 'session', sessionId: 'session-1' }, status: 'active', updatedAt: 'revision-1' }
function service() {
  return { list: vi.fn(async () => ({ items: [row], total: 21, shown: 1, offset: 0, limit: 20 })),
    create: vi.fn(async () => row), view: vi.fn(async () => row), edit: vi.fn(async () => row),
    run: vi.fn(async () => row), history: vi.fn(async () => ({ id: row.id, records: [], nextBefore: 'message-1' })) }
}
beforeEach(() => { vi.resetAllMocks() })
describe('rc.1 Host task commands', () => {
  it('labels the Host-wide paginated list and exposes the next page', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, '')
    expect(schedule.list).toHaveBeenCalledWith({ limit: 20, offset: 0 })
    expect(f.text()).toContain('Host tasks: 1 shown / 21 total')
    expect(f.text()).toContain('/schedule list 1 all')
  })
  it('forwards a bounded inactive page rather than a Session filter', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'list 20 inactive')
    expect(schedule.list).toHaveBeenCalledWith({ limit: 20, offset: 20, active: false })
  })
  it('accepts a list filter without an offset', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'list active')
    expect(schedule.list).toHaveBeenCalledWith({ limit: 20, offset: 0, active: true })
  })
  it('creates delayed reminders with typed timing and an explicit current-Session target', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'add 90 check build')
    expect(schedule.create).toHaveBeenCalledWith({ title: 'check build', prompt: 'check build', timing: { kind: 'after', after_seconds: 90 }, target: { kind: 'session', sessionId: 'session-1' } }, 'session-1', f.ctx.signal)
  })
  it('creates a recurring task with an explicit new-Session destination', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'create ' + JSON.stringify({ title: 'task', prompt: 'do task', timing: { kind: 'every', every_seconds: 300 }, target: { kind: 'new' } }))
    expect(schedule.create).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'new' }, timing: { kind: 'every', every_seconds: 300 } }), 'session-1', f.ctx.signal)
  })
  it('does not create after cancelling the structured editor', async () => {
    vi.mocked(showMultilineInput).mockResolvedValue(undefined)
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'create')
    expect(schedule.create).not.toHaveBeenCalled()
  })
  it('preserves unchanged timing and destination and sends the revision read before editing', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'edit schedule-1 {"title":"changed"}')
    expect(schedule.edit).toHaveBeenCalledWith({ id: 'schedule-1', action: 'update', patch: { title: 'changed' }, expectedUpdatedAt: 'revision-1' }, 'session-1', f.ctx.signal)
  })
  it.each(['pause', 'resume'])('uses the same atomic update for %s', async command => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, command + ' schedule-1')
    expect(schedule.edit).toHaveBeenCalledWith(expect.objectContaining({ patch: { active: command === 'resume' } }), 'session-1', f.ctx.signal)
  })
  it.each(['delete', 'run'])('does not %s without explicit confirmation', async command => {
    vi.mocked(showChoice).mockResolvedValue('no')
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, command + ' schedule-1')
    expect(schedule.edit).not.toHaveBeenCalled(); expect(schedule.run).not.toHaveBeenCalled()
  })
  it('deletes through edit with optimistic conflict protection', async () => {
    vi.mocked(showChoice).mockResolvedValue('yes')
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'delete schedule-1')
    expect(schedule.edit).toHaveBeenCalledWith({ id: 'schedule-1', action: 'delete', expectedUpdatedAt: 'revision-1' }, 'session-1', f.ctx.signal)
  })
  it('does not retry or overwrite a concurrent edit', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    schedule.edit.mockResolvedValue({ id: row.id, code: 'schedule_conflict' } as never)
    await scheduleCommand(f.ctx, 'edit schedule-1 {"prompt":"changed"}')
    expect(schedule.edit).toHaveBeenCalledTimes(1); expect(f.text()).toContain('review before editing again')
  })
  it('cancels mutation when the Session changes while confirmation is open', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    vi.mocked(showChoice).mockImplementation(async () => { f.abort.abort(); return 'yes' })
    await scheduleCommand(f.ctx, 'delete schedule-1')
    expect(schedule.edit).not.toHaveBeenCalled()
  })
  it('pages saved delivery receipts without executing a task', async () => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, 'history schedule-1 message-0')
    expect(schedule.history).toHaveBeenCalledWith({ id: row.id, limit: 20, before: 'message-0' }); expect(schedule.run).not.toHaveBeenCalled()
  })
  it.each(['list -1', 'create {"title":"x"}', 'add 0 title', 'edit schedule-1 {"active":"yes"}'])('rejects malformed input: %s', async command => {
    const schedule = service(), f = commandFixture({ schedule })
    await scheduleCommand(f.ctx, command)
    expect(schedule.create).not.toHaveBeenCalled(); expect(schedule.edit).not.toHaveBeenCalled()
  })
})
describe('Schedule JSON parsing', () => {
  it.each([
    { kind: 'after', after_seconds: 10 }, { kind: 'every', every_seconds: 60 },
    { kind: 'at', at: '2026-12-01T00:00:00Z' }, { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
    { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 5] } },
    { kind: 'cron', cron: { expression: '0 9 * * *', time_zone: 'UTC' } },
    { kind: 'rrule', rrule: 'DTSTART:20261201T000000Z\nRRULE:FREQ=DAILY' },
  ])('preserves explicit $kind timing', timing => { expect(parseScheduleTiming(timing)).toEqual(timing) })
  it('defaults create to the caller, while an edit never adds omitted fields', () => {
    expect(parseScheduleCreate('{"title":"t","prompt":"p","timing":{"kind":"after","after_seconds":60}}', 's1' as never).target).toEqual({ kind: 'session', sessionId: 's1' })
    expect(parseSchedulePatch('{"title":"x"}')).toEqual({ title: 'x' })
  })
  it.each(['{"sessionId":"old"}', '{}', '{"title":2}', '{"active":null}'])('refuses unknown, empty or mistyped edits %s', json => {
    expect(() => parseSchedulePatch(json)).toThrow()
  })
})
