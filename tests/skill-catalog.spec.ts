import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  skillBadge,
  skillCounts,
  skillPage,
  skillProvenance,
  skillRows,
  type SkillRow,
  type SkillSummaryLike,
} from '../src/runtime/skill-catalog.js'

/** One catalog entry in the shape `ctx.skills.list()` returns. */
function summary(overrides: Partial<SkillSummaryLike> = {}): SkillSummaryLike {
  return {
    name: 'find-skills',
    description: 'Helps users discover and install agent skills.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-agents',
    provider: 'filesystem',
    ...overrides,
  }
}

/** One already-normalized row. */
function row(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    name: 'find-skills',
    description: 'Helps users discover and install agent skills.',
    userInvocable: true,
    modelInvocable: true,
    provenance: 'user-agents',
    ...overrides,
  }
}

describe('skill provenance', () => {
  it('names the discovery root a filesystem skill came from', () => {
    expect(skillProvenance('user-agents', 'filesystem')).toBe('user-agents')
    expect(skillProvenance('project-dsh', 'filesystem')).toBe('project-dsh')
    expect(skillProvenance('custom', 'filesystem')).toBe('custom')
  })

  it('names the package when a bundled provider owns the body', () => {
    // The root says only "bundled"; the provider says which package supplied
    // it, which is the fact a reader needs.
    expect(skillProvenance('bundled', 'dsh-badge')).toBe('dsh-badge')
    expect(skillProvenance('bundled', 'bigpowers')).toBe('bigpowers')
  })

  it('falls back without inventing a source', () => {
    // A provider that names only its root keeps that root rather than showing
    // the generic default provider name.
    expect(skillProvenance('bundled', 'filesystem')).toBe('bundled')
    expect(skillProvenance('bundled', undefined)).toBe('bundled')
    expect(skillProvenance(undefined, 'some-provider')).toBe('some-provider')
    expect(skillProvenance(undefined, undefined)).toBe('unknown')
    expect(skillProvenance('', '')).toBe('unknown')
  })
})

describe('skill badges', () => {
  it('states both invocation controls', () => {
    expect(skillBadge({ userInvocable: true, modelInvocable: true, provenance: 'user-agents' }))
      .toBe('[u,m:user-agents]')
    expect(skillBadge({ userInvocable: true, modelInvocable: false, provenance: 'user-agents' }))
      .toBe('[u:user-agents]')
    expect(skillBadge({ userInvocable: false, modelInvocable: true, provenance: 'bundled' }))
      .toBe('[m:bundled]')
  })

  it('shows a skill nobody may invoke instead of dropping it', () => {
    // A skill registered with both controls off is dead weight; listing it is
    // how a reader notices, so the badge has to exist.
    expect(skillBadge({ userInvocable: false, modelInvocable: false, provenance: 'custom' }))
      .toBe('[-:custom]')
  })
})

describe('skill rows', () => {
  it('normalizes and sorts by name', () => {
    const rows = skillRows([
      summary({ name: 'zeta' }),
      summary({ name: 'alpha', source: 'project-dsh' }),
    ])
    expect(rows.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
    expect(rows[0]).toMatchObject({ provenance: 'project-dsh', userInvocable: true, modelInvocable: true })
  })

  it('treats an omitted invocation policy as allowing both', () => {
    // The Host defaults an omitted policy to both surfaces; reading it as
    // "neither" would hide every skill a provider forgot to annotate.
    const [entry] = skillRows([summary({ invocation: undefined })])
    expect(entry).toMatchObject({ userInvocable: true, modelInvocable: true })
  })

  it('keeps an explicit opt-out', () => {
    const rows = skillRows([
      summary({ name: 'user-only', invocation: { modelInvocable: false, userInvocable: true } }),
      summary({ name: 'model-only', invocation: { modelInvocable: true, userInvocable: false } }),
    ])
    expect(rows.map(entry => [entry.name, entry.userInvocable, entry.modelInvocable])).toEqual([
      ['model-only', false, true],
      ['user-only', true, false],
    ])
  })

  it('carries the optional metadata through', () => {
    const [entry] = skillRows([summary({ whenToUse: 'when asked', path: '/tmp/s/SKILL.md' })])
    expect(entry).toMatchObject({ whenToUse: 'when asked', path: '/tmp/s/SKILL.md' })
  })
})

describe('skill counts', () => {
  it('splits user-invocable from model-only, ignoring dead entries', () => {
    const rows = [
      row(),
      row({ name: 'b', userInvocable: false, modelInvocable: true }),
      row({ name: 'c', userInvocable: false, modelInvocable: false }),
    ]
    // user counts everything a human may invoke; modelOnly is the subset a
    // reader has to watch, which is why the dead entry appears in neither.
    expect(skillCounts(rows)).toEqual({ total: 3, user: 1, modelOnly: 1 })
  })
})

describe('skill page', () => {
  const many = Array.from({ length: 40 }, (_, index) => row({
    name: 'skill-' + String(index).padStart(2, '0'),
    description: 'Does the thing for case ' + String(index) + '.',
  }))

  it('pages the table and reports the paging state', () => {
    const page = skillPage(many, { width: 100, page: 2, pageSize: 15 })
    expect(page.page).toBe(2)
    expect(page.pages).toBe(3)
    expect(page.total).toBe(40)
    expect(page.lines).toHaveLength(15)
    expect(page.lines[0]).toContain('skill-15')
  })

  it('clamps an out-of-range page instead of printing nothing', () => {
    expect(skillPage(many, { width: 100, page: 99, pageSize: 15 }).page).toBe(3)
    expect(skillPage(many, { width: 100, page: 0, pageSize: 15 }).page).toBe(1)
    expect(skillPage(many, { width: 100, page: -4, pageSize: 15 }).page).toBe(1)
    expect(skillPage(many, { width: 100, page: Number.NaN, pageSize: 15 }).page).toBe(1)
  })

  it('always reports at least one page so a footer never divides by zero', () => {
    expect(skillPage([], { width: 100 }).pages).toBe(1)
    expect(skillPage([], { width: 100 }).lines).toEqual([])
  })

  it('aligns the name and badge columns across rows', () => {
    const rows = [
      row({ name: 'a', provenance: 'user-agents' }),
      row({ name: 'much-longer-name', provenance: 'dsh-badge' }),
    ]
    const lines = skillPage(rows, { width: 120 }).lines
    // Both descriptions start at the same column, so the table reads as columns.
    const columns = lines.map(line => line.indexOf('Helps users discover'))
    expect(new Set(columns).size).toBe(1)
  })

  it('never exceeds the requested width', () => {
    for (const width of [40, 60, 100, 160]) {
      for (const line of skillPage(many, { width, pageSize: 40 }).lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('drops the description rather than the identity on a narrow terminal', () => {
    // Identity is what a reader scans for; truncating it away to keep prose
    // would make the list useless at 40 columns.
    const lines = skillPage(many, { width: 30, pageSize: 3 }).lines
    expect(lines[0]).toContain('skill-00')
    expect(lines[0]).not.toContain('Does the thing')
  })
})
