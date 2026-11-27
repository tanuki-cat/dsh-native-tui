import { describe, expect, it, vi } from 'vitest'
import type { SkillSummaryLike } from '../src/runtime/skill-catalog.js'
import type { HostSession } from '../src/runtime/agent.js'
import { SKILLS_CACHE_MS, SkillCatalogCache } from '../src/ui/skill-cache.js'

const agent = (cwd: string | null = '/work') => ({ session: { header: cwd === null ? {} : { cwd } } }) as never
const workingDirectory = (agent: HostSession['agent']) => agent.session.header.cwd ?? '/default'

const summary = (name: string, userInvocable = true): SkillSummaryLike => ({
  name,
  description: name + ' skill',
  invocation: { userInvocable, modelInvocable: true },
})

function harness(rows: readonly SkillSummaryLike[] = [summary('alpha')]) {
  const list = vi.fn(async () => rows)
  const cache = new SkillCatalogCache(() => ({ list }), workingDirectory, () => true)
  return { list, cache }
}

describe('skill catalog cache', () => {
  it('serves one typing burst with a single catalog reading', async () => {
    const h = harness()
    const target = agent()
    expect((await h.cache.load(target, () => 0)).map(row => row.name)).toEqual(['alpha'])
    await h.cache.load(target, () => SKILLS_CACHE_MS - 1)
    expect(h.list).toHaveBeenCalledTimes(1)
    await h.cache.load(target, () => SKILLS_CACHE_MS)
    expect(h.list).toHaveBeenCalledTimes(2)
  })

  it('lists only skills a human may invoke and scopes the read to the Agent', async () => {
    const h = harness([summary('alpha'), summary('beta', false)])
    const target = agent('/work')
    const rows = await h.cache.load(target, () => 0)
    expect(rows.map(row => row.name)).toEqual(['alpha'])
    expect(h.list).toHaveBeenCalledWith({ cwd: '/work', scope: target })
  })

  it('falls back to the configured directory when the Session recorded none', async () => {
    const h = harness()
    const target = agent(null)
    await h.cache.load(target, () => 0)
    expect(h.list).toHaveBeenCalledWith({ cwd: '/default', scope: target })
  })

  it('keeps a reading per Agent instead of sharing it across sessions', async () => {
    const h = harness()
    await h.cache.load(agent('/a'), () => 0)
    await h.cache.load(agent('/b'), () => 0)
    expect(h.list).toHaveBeenCalledTimes(2)
  })

  it('reports an empty menu when the Host exposes no catalog or the read fails', async () => {
    const missing = new SkillCatalogCache(() => undefined, workingDirectory, () => true)
    expect(await missing.load(agent(), () => 0)).toEqual([])
    const failing = new SkillCatalogCache(() => ({ list: async () => { throw new Error('no catalog') } }), workingDirectory, () => true)
    expect(await failing.load(agent(), () => 0)).toEqual([])
  })

  it('drops the reading when the menu is invalidated', async () => {
    const h = harness()
    const target = agent()
    await h.cache.load(target, () => 0)
    h.cache.clear()
    await h.cache.load(target, () => 0)
    expect(h.list).toHaveBeenCalledTimes(2)
  })

  it('does not keep rows that arrive after the session switched away', async () => {
    let current = true
    const list = vi.fn(async () => [summary('alpha')])
    const cache = new SkillCatalogCache(() => ({ list }), workingDirectory, () => current)
    const target = agent()
    const first = cache.load(target, () => 0)
    current = false
    await first
    await cache.load(agent('/elsewhere'), () => 0)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('discards results if the same Agent entered another worktree during discovery', async () => {
    let resolveRead!: (rows: SkillSummaryLike[]) => void
    const pending = new Promise<SkillSummaryLike[]>(resolve => { resolveRead = resolve })
    let cwd = '/original'
    const list = vi.fn().mockReturnValueOnce(pending).mockResolvedValue([summary('new')])
    const cache = new SkillCatalogCache(() => ({ list }), () => cwd, () => true)
    const target = agent()
    const reading = cache.load(target, () => 0)
    cwd = '/worktree'
    resolveRead([summary('old')])
    expect(await reading).toEqual([])
    expect((await cache.load(target, () => 1)).map(row => row.name)).toEqual(['new'])
    expect(list).toHaveBeenLastCalledWith({ cwd, scope: target })
  })

  it('shares one in-flight read for the same Agent and worktree', async () => {
    let resolveRead!: (rows: SkillSummaryLike[]) => void
    const pending = new Promise<SkillSummaryLike[]>(resolve => { resolveRead = resolve })
    const list = vi.fn(() => pending)
    const cache = new SkillCatalogCache(() => ({ list }), workingDirectory, () => true)
    const target = agent()
    const first = cache.load(target, () => 0)
    const second = cache.load(target, () => 0)
    expect(list).toHaveBeenCalledTimes(1)
    resolveRead([summary('alpha')])
    expect((await first).map(row => row.name)).toEqual(['alpha'])
    expect((await second).map(row => row.name)).toEqual(['alpha'])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('caches a failed catalog read for the TTL', async () => {
    const list = vi.fn(async () => { throw new Error('catalog unavailable') })
    const cache = new SkillCatalogCache(() => ({ list }), workingDirectory, () => true)
    const target = agent()
    expect(await cache.load(target, () => 0)).toEqual([])
    expect(await cache.load(target, () => SKILLS_CACHE_MS - 1)).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    await cache.load(target, () => SKILLS_CACHE_MS)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not let an older read overwrite a newer generation', async () => {
    let resolveOld!: (rows: SkillSummaryLike[]) => void
    let resolveNew!: (rows: SkillSummaryLike[]) => void
    const oldRead = new Promise<SkillSummaryLike[]>(resolve => { resolveOld = resolve })
    const newRead = new Promise<SkillSummaryLike[]>(resolve => { resolveNew = resolve })
    const list = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(newRead)
    const cache = new SkillCatalogCache(() => ({ list }), workingDirectory, () => true)
    const target = agent()
    const stale = cache.load(target, () => 0)
    cache.clear()
    const fresh = cache.load(target, () => 0)
    resolveNew([summary('new')])
    expect((await fresh).map(row => row.name)).toEqual(['new'])
    resolveOld([summary('old')])
    expect(await stale).toEqual([])
    expect((await cache.load(target, () => 1)).map(row => row.name)).toEqual(['new'])
  })
})
