import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitBranchReader, readGitBranch } from '../src/runtime/git-branch.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One temp directory holding a `.git` directory whose HEAD is `head`. */
async function repo(head = 'ref: refs/heads/main'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-tui-git-branch-'))
  cleanup.push(dir)
  await mkdir(join(dir, '.git'))
  await writeFile(join(dir, '.git', 'HEAD'), head + '\n')
  return dir
}

describe('readGitBranch', () => {
  it('reads the branch HEAD names', async () => {
    expect(readGitBranch(await repo())).toBe('main')
    expect(readGitBranch(await repo('ref: refs/heads/feat/status-line'))).toBe('feat/status-line')
  })

  it('walks up from a subdirectory to the enclosing repository', async () => {
    const root = await repo()
    const nested = join(root, 'src', 'ui')
    await mkdir(nested, { recursive: true })
    expect(readGitBranch(nested)).toBe('main')
  })

  it('reports a short commit id when HEAD is detached', async () => {
    expect(readGitBranch(await repo('0123456789abcdef0123456789abcdef01234567'))).toBe('0123456')
  })

  it('follows the git directory a linked worktree points at', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-tui-git-branch-'))
    cleanup.push(root)
    await mkdir(join(root, 'worktree-git'))
    await writeFile(join(root, 'worktree-git', 'HEAD'), 'ref: refs/heads/worktree-branch\n')
    const checkout = join(root, 'checkout')
    await mkdir(checkout)
    await writeFile(join(checkout, '.git'), 'gitdir: ../worktree-git\n')
    expect(readGitBranch(checkout)).toBe('worktree-branch')
  })

  it('omits the branch outside a repository or without a readable HEAD', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'native-tui-git-branch-'))
    cleanup.push(outside)
    expect(readGitBranch(outside)).toBeUndefined()
    // A repository directory whose HEAD is missing is not a branch to show.
    const broken = await mkdtemp(join(tmpdir(), 'native-tui-git-branch-'))
    cleanup.push(broken)
    await mkdir(join(broken, '.git'))
    expect(readGitBranch(broken)).toBeUndefined()
  })

  it('ignores HEAD values that name no branch', async () => {
    expect(readGitBranch(await repo('ref: refs/tags/v1'))).toBeUndefined()
    expect(readGitBranch(await repo('ref: refs/heads/'))).toBeUndefined()
    expect(readGitBranch(await repo('not a ref'))).toBeUndefined()
    expect(readGitBranch(await repo(''))).toBeUndefined()
  })

  it('treats a .git file without a gitdir target as no repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-tui-git-branch-'))
    cleanup.push(root)
    await writeFile(join(root, '.git'), 'not a pointer\n')
    expect(readGitBranch(root)).toBeUndefined()
  })
})

describe('createGitBranchReader', () => {
  it('caches one reading for its interval and re-reads it afterwards', async () => {
    const root = await repo('ref: refs/heads/main')
    let now = 0
    const branch = createGitBranchReader(1000, () => now)
    expect(branch(root)).toBe('main')
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/next\n')
    expect(branch(root)).toBe('main')
    now = 1000
    expect(branch(root)).toBe('next')
  })

  it('keeps one reading per workspace', async () => {
    const first = await repo('ref: refs/heads/first')
    const second = await repo('ref: refs/heads/second')
    const branch = createGitBranchReader(1000, () => 0)
    expect(branch(first)).toBe('first')
    expect(branch(second)).toBe('second')
    expect(branch(first)).toBe('first')
  })
})
