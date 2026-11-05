/** JSON input for Host tasks; the Schedule service validates recurrence and target availability. */
import type { ScheduleCreateRequest, SchedulePatch, ScheduleTiming, ScheduleTargetRequest } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type Fields = Record<string, unknown>
function object(value: unknown, keys: readonly string[]): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a JSON object')
  const fields = value as Fields
  for (const key of Object.keys(fields)) if (!keys.includes(key)) throw new Error('Unknown field: ' + key)
  return fields
}
function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(key + ' must be a non-empty string')
  return value
}
function integer(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(key + ' must be a positive integer')
  return value
}
function localTime(value: unknown): { time: string; time_zone: string } {
  const row = object(value, ['time', 'time_zone', 'weekdays'])
  return { time: text(row.time, 'time'), time_zone: text(row.time_zone, 'time_zone') }
}
/** Parse the public timing union without changing or inferring its time zone. */
export function parseScheduleTiming(value: unknown): ScheduleTiming {
  const row = object(value, ['kind', 'after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron', 'rrule'])
  const field = row.kind === 'after' ? 'after_seconds' : row.kind === 'every' ? 'every_seconds' : row.kind
  if (typeof field !== 'string') throw new Error('timing.kind is required')
  object(value, ['kind', field])
  switch (row.kind) {
    case 'after': return { kind: 'after', after_seconds: integer(row.after_seconds, 'after_seconds') }
    case 'every': return { kind: 'every', every_seconds: integer(row.every_seconds, 'every_seconds') }
    case 'at': {
      if (typeof row.at === 'string') return { kind: 'at', at: text(row.at, 'at') }
      const at = object(row.at, ['date', 'time', 'time_zone'])
      return { kind: 'at', at: { date: text(at.date, 'date'), time: text(at.time, 'time'), time_zone: text(at.time_zone, 'time_zone') } }
    }
    case 'daily': object(row.daily, ['time', 'time_zone']); return { kind: 'daily', daily: localTime(row.daily) }
    case 'weekly': {
      const weekly = object(row.weekly, ['time', 'time_zone', 'weekdays'])
      if (!Array.isArray(weekly.weekdays) || weekly.weekdays.length === 0) throw new Error('weekdays must be a non-empty array')
      return { kind: 'weekly', weekly: { ...localTime(weekly), weekdays: weekly.weekdays.map(day => integer(day, 'weekday')) } }
    }
    case 'cron': {
      const cron = object(row.cron, ['expression', 'time_zone'])
      return { kind: 'cron', cron: { expression: text(cron.expression, 'expression'), time_zone: text(cron.time_zone, 'time_zone') } }
    }
    case 'rrule': return { kind: 'rrule', rrule: text(row.rrule, 'rrule') }
    default: throw new Error('Unknown timing.kind: ' + String(row.kind))
  }
}
function target(value: unknown): ScheduleTargetRequest {
  const row = object(value, ['kind', 'sessionId', 'create'])
  if (row.kind === 'session') {
    object(value, ['kind', 'sessionId'])
    return { kind: 'session', sessionId: text(row.sessionId, 'sessionId') as SessionId }
  }
  if (row.kind !== 'new' && row.kind !== 'new_once') throw new Error('target.kind must be session, new_once, or new')
  object(value, ['kind', 'create'])
  if (row.create === undefined) return { kind: row.kind }
  const create = object(row.create, ['cwd', 'agentPreset'])
  return { kind: row.kind, create: {
    ...create.cwd === undefined ? {} : { cwd: text(create.cwd, 'cwd') },
    ...create.agentPreset === undefined ? {} : { agentPreset: text(create.agentPreset, 'agentPreset') },
  } }
}
/** Omitted destinations keep the command's current Session, not the Host's new-session default. */
export function parseScheduleCreate(json: string, sessionId: SessionId): ScheduleCreateRequest {
  const row = object(JSON.parse(json), ['title', 'prompt', 'timing', 'target'])
  return { title: text(row.title, 'title'), prompt: text(row.prompt, 'prompt'), timing: parseScheduleTiming(row.timing),
    target: row.target === undefined ? { kind: 'session', sessionId } : target(row.target) }
}
/** Omitted fields remain untouched, including recurrence and delivery destination. */
export function parseSchedulePatch(json: string): SchedulePatch {
  const row = object(JSON.parse(json), ['title', 'prompt', 'timing', 'target', 'active'])
  if (Object.keys(row).length === 0) throw new Error('Provide at least one field to edit')
  if (row.active !== undefined && typeof row.active !== 'boolean') throw new Error('active must be boolean')
  return {
    ...row.title === undefined ? {} : { title: text(row.title, 'title') },
    ...row.prompt === undefined ? {} : { prompt: text(row.prompt, 'prompt') },
    ...row.timing === undefined ? {} : { timing: parseScheduleTiming(row.timing) },
    ...row.target === undefined ? {} : { target: target(row.target) },
    ...row.active === undefined ? {} : { active: row.active },
  }
}
