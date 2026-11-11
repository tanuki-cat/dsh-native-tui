import { describe, expect, it } from 'vitest'
import { formatReleaseNotes } from '../scripts/release-notes.js'

const notes = (...entries: Array<[string, string]>): string =>
  formatReleaseNotes(entries.map(([hash, subject]) => ({ hash, subject })))

describe('release notes', () => {
  it('groups conventional commits and drops the type prefix', () => {
    const text = notes(['aaa1111', 'feat: 统一详情入口'], ['bbb2222', 'fix(ui): 修复滚动'])
    expect(text).toContain('### 新功能\n- 统一详情入口 (aaa1111)')
    expect(text).toContain('### 修复\n- 修复滚动 (bbb2222)')
    expect(text.indexOf('### 新功能')).toBeLessThan(text.indexOf('### 修复'))
  })

  it('lifts breaking changes, merges shared sections and keeps the declared order', () => {
    const text = notes(['ccc3333', 'feat(api)!: 移除旧接口'], ['ddd4444', 'build: 升级构建'], ['eee5555', 'ci: 增加工作流'])
    expect(text.indexOf('### 破坏性变更')).toBeLessThan(text.indexOf('### 构建与 CI'))
    expect(text.match(/### 构建与 CI/gu)).toHaveLength(1)
    expect(text).toContain('- 升级构建 (ddd4444)')
    expect(text).toContain('- 增加工作流 (eee5555)')
  })

  it('keeps unknown types and plain subjects under other changes', () => {
    const text = notes(['fff6666', 'wip: 试验'], ['ggg7777', '更新文档说明'])
    expect(text).toContain('### 其他变更\n- 试验 (fff6666)\n- 更新文档说明 (ggg7777)')
  })

  it('skips merge commits and empty subjects', () => {
    const text = notes(['1111111', 'Merge branch main'], ['2222222', '   '], ['3333333', 'fix: 修复'])
    expect(text).not.toContain('Merge branch main')
    expect(text).toBe('## 变更\n\n### 修复\n- 修复 (3333333)\n')
  })

  it('renders a fallback when there is nothing to summarize', () => {
    expect(formatReleaseNotes([])).toBe('## 变更\n\n- 本版本没有可汇总的提交。\n')
  })
})
