import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One commit reduced to the fields a changelog needs. */
export interface CommitEntry {
  readonly hash: string
  readonly subject: string
}

const BREAKING = '破坏性变更'
const OTHER = '其他变更'

/** Conventional Commit type to changelog section; both build types share one heading. */
const SECTIONS: Readonly<Record<string, string>> = {
  feat: '新功能',
  fix: '修复',
  perf: '性能',
  refactor: '重构',
  docs: '文档',
  test: '测试',
  build: '构建与 CI',
  ci: '构建与 CI',
  chore: '维护',
  style: '样式',
  revert: '回滚',
}
const ORDER: readonly string[] = [BREAKING, ...new Set(Object.values(SECTIONS)), OTHER]

const CONVENTIONAL = /^([a-z]+)(?:\([^)]*\))?(!)?:\s+(.+)$/iu

interface Summarized {
  readonly section: string
  readonly text: string
}

function summarize(subject: string): Summarized | undefined {
  const match = CONVENTIONAL.exec(subject)
  if (match === null) return undefined
  const type = match[1]?.toLowerCase()
  const text = match[3]
  if (type === undefined || text === undefined) return undefined
  if (match[2] === '!') return { section: BREAKING, text }
  return { section: SECTIONS[type] ?? OTHER, text }
}

/**
 * Group commits into a Markdown changelog.
 * @param entries - commits in the order they should appear in the notes.
 * @returns the release notes body.
 */
export function formatReleaseNotes(entries: readonly CommitEntry[]): string {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const subject = entry.subject.trim()
    if (subject === '' || subject.startsWith('Merge ')) continue
    const summarized = summarize(subject)
    const section = summarized?.section ?? OTHER
    const lines = groups.get(section) ?? []
    lines.push('- ' + (summarized?.text ?? subject) + ' (' + entry.hash + ')')
    groups.set(section, lines)
  }
  const blocks: string[] = ['## 变更']
  for (const section of ORDER) {
    const lines = groups.get(section)
    if (lines === undefined) continue
    blocks.push('', '### ' + section, ...lines)
  }
  if (blocks.length === 1) blocks.push('', '- 本版本没有可汇总的提交。')
  return blocks.join('\n') + '\n'
}

/**
 * Read the commits a release range covers, oldest first.
 * @param from - previous release tag, or an empty string for the first release.
 * @param to - the tag or ref being released.
 * @returns one entry per non-merge commit.
 */
export function readCommits(from: string, to: string): CommitEntry[] {
  const range = from === '' ? to : from + '..' + to
  const output = execFileSync('git', ['log', '--no-merges', '--reverse', '--pretty=format:%h%x09%s', range], { encoding: 'utf8' })
  return output.split('\n').filter(line => line !== '').map(line => {
    const tab = line.indexOf('\t')
    return { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
  })
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function main(argv: readonly string[]): void {
  const to = option(argv, '--to')
  if (to === undefined || to === '') throw new Error('release-notes: --to <ref> is required')
  process.stdout.write(formatReleaseNotes(readCommits(option(argv, '--from') ?? '', to)))
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
