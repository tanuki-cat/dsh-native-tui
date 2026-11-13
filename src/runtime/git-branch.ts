/**
 * The branch a workspace's repository is checked out on.
 *
 * The status row repaints on every Session event, so the branch is read from
 * the repository's `HEAD` file instead of by spawning `git`: the read costs a
 * few syscalls and still works when the binary is absent from `PATH`.
 *
 * @module dsh-native-tui/runtime/git-branch
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `HEAD` names a branch through this ref prefix; any other ref is not a branch. */
const BRANCH_REF_PREFIX = 'refs/heads/'

/** Characters kept from a commit id when `HEAD` is detached. */
const DETACHED_ID_CHARS = 7

/** How long one cached reading stands before the next lookup re-reads `HEAD`. */
const DEFAULT_REFRESH_MS = 1000

/**
 * Follow a `.git` file (a linked worktree or a submodule) to its git directory.
 * @param file - the `.git` file to read.
 * @param directory - the directory containing it; relative targets resolve against it.
 * @returns the git directory, or `undefined` when the file names none.
 */
function readGitDirPointer(file: string, directory: string): string | undefined {
  const line = readFileSync(file, 'utf8').split('\n', 1)[0] ?? ''
  if (!line.startsWith('gitdir:')) return undefined
  const target = line.slice('gitdir:'.length).trim()
  return target === '' ? undefined : resolve(directory, target)
}

/**
 * Find the git directory enclosing a directory.
 * @param directory - absolute directory to start from.
 * @returns the enclosing repository's git directory, or `undefined` above the filesystem root.
 */
function findGitDir(directory: string): string | undefined {
  let current = directory
  for (;;) {
    const candidate = join(current, '.git')
    const entry = statSync(candidate, { throwIfNoEntry: false })
    if (entry?.isDirectory()) return candidate
    if (entry?.isFile()) return readGitDirPointer(candidate, current)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Read the revision `HEAD` names.
 * @param gitDir - the repository's git directory.
 * @returns the branch name, or a short commit id when `HEAD` is detached.
 */
function readHead(gitDir: string): string | undefined {
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  if (head.startsWith('ref:')) {
    const ref = head.slice('ref:'.length).trim()
    if (!ref.startsWith(BRANCH_REF_PREFIX)) return undefined
    return ref.slice(BRANCH_REF_PREFIX.length) || undefined
  }
  return /^[0-9a-f]{40}$/iu.test(head) ? head.slice(0, DETACHED_ID_CHARS) : undefined
}

/**
 * Read the branch checked out for a workspace directory.
 * @param cwd - directory the session edits; a subdirectory reports its enclosing repository's branch.
 * @returns the branch name, a short commit id for a detached `HEAD`, or `undefined` outside any repository.
 */
export function readGitBranch(cwd: string): string | undefined {
  try {
    const gitDir = findGitDir(resolve(cwd))
    return gitDir === undefined ? undefined : readHead(gitDir)
  } catch {
    // An unreadable `.git` (permissions, a worktree whose target moved) leaves
    // no branch to show, and a status repaint must not fail over it.
    return undefined
  }
}

/** Look up the branch for a workspace directory. */
export type GitBranchReader = (cwd: string) => string | undefined

/**
 * Cache {@link readGitBranch} per workspace.
 *
 * Re-reading `HEAD` on every repaint would stat the repository for a value that
 * changes only on a checkout. A reading older than `ttlMs` is re-read, so a
 * checkout made outside the terminal reaches the next repaint after that
 * interval instead of only after a restart.
 * @param ttlMs - how long one reading stands.
 * @param now - clock that ages readings, injectable for tests.
 * @returns a lookup that reads at most once per workspace and interval.
 */
export function createGitBranchReader(ttlMs = DEFAULT_REFRESH_MS, now: () => number = Date.now): GitBranchReader {
  const readings = new Map<string, { readonly branch: string | undefined; readonly readAt: number }>()
  return (cwd: string): string | undefined => {
    const key = resolve(cwd)
    const at = now()
    const cached = readings.get(key)
    if (cached !== undefined && at - cached.readAt < ttlMs) return cached.branch
    const branch = readGitBranch(key)
    readings.set(key, { branch, readAt: at })
    return branch
  }
}
