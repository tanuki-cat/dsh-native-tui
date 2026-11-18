import { describe, expect, it, vi } from 'vitest'
import type { SkillSummaryLike } from '../src/runtime/skill-catalog.js'
import { SKILLS_CACHE_MS, SkillCatalogCache } from '../src/ui/skill-cache.js'

const agent = (cwd: string | null = '/work') => ({ session: { header: cwd === null ? {} : { cwd } } }) as never

const summary = (name: string, userInvocable = true): SkillSummaryLike => ({
  name,
  description: name + ' skill',
  invocation: { userInvocable, modelInvocable: true },
})

function harness(rows: readonly SkillSummaryLike[] = [summary('alpha')]) {
  const list = vi.fn(async () => rows)
  const cache = new SkillCatalogCache(() => ({ list }), () => '/default', () => true)
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
    const missing = new SkillCatalogCache(() => undefined, () => '/default', () => true)
    expect(await missing.load(agent(), () => 0)).toEqual([])
    const failing = new SkillCatalogCache(() => ({ list: async () => { throw new Error('no catalog') } }), () => '/default', () => true)
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
    const cache = new SkillCatalogCache(() => ({ list }), () => '/default', () => current)
    const target = agent()
    const first = cache.load(target, () => 0)
    current = false
    await first
    await cache.load(agent('/elsewhere'), () => 0)
    expect(list).toHaveBeenCalledTimes(2)
  })
})
