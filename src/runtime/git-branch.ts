/**
 * The branch a workspace's repository is checked out on.
 *
 * The status row repaints on every Session event, so the branch is read from
 * the repository's `HEAD` file instead of by spawning `git`: the read costs a
 * few syscalls and still works when the binary is absent from `PATH`.
 *
 * @module dsh-native-tui/runtime/git-branch
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Maximum bytes read from `.git` or `.git/HEAD`. */
const MAX_GIT_FILE_BYTES = 4096

/** `HEAD` names a branch through this ref prefix; any other ref is not a branch. */
const BRANCH_REF_PREFIX = 'refs/heads/'

/** Characters kept from a commit id when `HEAD` is detached. */
const DETACHED_ID_CHARS = 7

/**
 * How long one cached reading stands before the next lookup re-reads `HEAD`.
 *
 * A checkout is the only thing that changes it, and a status repaint must not
 * pay a synchronous filesystem walk on its way to a frame.
 */
const DEFAULT_REFRESH_MS = 5000

/** One workspace's last reading, including the git directory it was found at. */
interface BranchReading {
  readonly branch: string | undefined
  readonly readAt: number
  /** Git directory the reading came from (`null` when outside any repository). */
  readonly gitDir: string | null
}

function readSmallFileSync(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('not a regular file')
    const cap = Math.min(MAX_GIT_FILE_BYTES, Math.max(0, info.size))
    if (cap === 0) return ''
    const buffer = Buffer.allocUnsafe(cap)
    const bytesRead = readSync(fd, buffer, 0, cap, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

async function readSmallFileAsync(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    const cap = Math.min(MAX_GIT_FILE_BYTES, Math.max(0, info.size))
    if (cap === 0) return ''
    const buffer = Buffer.allocUnsafe(cap)
    const { bytesRead } = await handle.read(buffer, 0, cap, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function parseGitDirPointer(content: string, directory: string): string | undefined {
  const line = content.split('\n', 1)[0] ?? ''
  if (!line.startsWith('gitdir:')) return undefined
  const target = line.slice('gitdir:'.length).trim()
  return target === '' ? undefined : resolve(directory, target)
}

function parseHead(content: string): string | undefined {
  const head = content.trim()
  if (head.startsWith('ref:')) {
    const ref = head.slice('ref:'.length).trim()
    if (!ref.startsWith(BRANCH_REF_PREFIX)) return undefined
    return ref.slice(BRANCH_REF_PREFIX.length) || undefined
  }
  return /^[0-9a-f]{40}$/iu.test(head) ? head.slice(0, DETACHED_ID_CHARS) : undefined
}

/**
 * Follow a `.git` file (a linked worktree or a submodule) to its git directory.
 * @param file - the `.git` file to read.
 * @param directory - the directory containing it; relative targets resolve against it.
 * @returns the git directory, or `undefined` when the file names none.
 */
function readGitDirPointer(file: string, directory: string): string | undefined {
  return parseGitDirPointer(readSmallFileSync(file), directory)
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

async function findGitDirAsync(directory: string): Promise<string | undefined> {
  let current = directory
  for (;;) {
    const candidate = join(current, '.git')
    const entry = await stat(candidate).catch(() => undefined)
    if (entry?.isDirectory()) return candidate
    if (entry?.isFile()) return parseGitDirPointer(await readSmallFileAsync(candidate), current)
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
  return parseHead(readSmallFileSync(join(gitDir, 'HEAD')))
}

/**
 * Read the branch checked out for a workspace directory.
 * @param cwd - directory the session edits; a subdirectory reports its enclosing repository's branch.
 * @returns the branch name, a short commit id for a detached `HEAD`, or `undefined` outside any repository.
 */
export function readGitBranch(cwd: string): string | undefined {
  return readBranch(resolve(cwd), undefined).branch
}

/**
 * Read the branch of one workspace, reusing an already-discovered git directory.
 *
 * The parent walk is what a slow or network-mounted workspace makes expensive:
 * it visits every ancestor until it finds `.git`. A repository does not move
 * between repaints, so only the `HEAD` read has to repeat — and the cached
 * directory is revalidated before it is trusted.
 * @param cwd - absolute directory to read.
 * @param known - git directory an earlier reading found, when one did.
 * @returns the branch and the git directory it came from.
 */
function readBranch(cwd: string, known: string | null | undefined): Pick<BranchReading, 'branch' | 'gitDir'> {
  try {
    const gitDir = known === null
      ? undefined
      : known !== undefined && statSync(known, { throwIfNoEntry: false })?.isDirectory() === true
        ? known
        : findGitDir(cwd)
    return { branch: gitDir === undefined ? undefined : readHead(gitDir), gitDir: gitDir ?? null }
  } catch {
    // An unreadable `.git` (permissions, a worktree whose target moved) leaves
    // no branch to show, and a status repaint must not fail over it.
    return { branch: undefined, gitDir: null }
  }
}

async function readBranchAsync(cwd: string, known: string | null | undefined): Promise<Pick<BranchReading, 'branch' | 'gitDir'>> {
  try {
    let gitDir: string | undefined
    if (known !== null && known !== undefined) {
      const info = await stat(known).catch(() => undefined)
      if (info?.isDirectory()) gitDir = known
    }
    gitDir ??= await findGitDirAsync(cwd)
    if (gitDir === undefined) return { branch: undefined, gitDir: null }
    return { branch: parseHead(await readSmallFileAsync(join(gitDir, 'HEAD'))), gitDir }
  } catch {
    return { branch: undefined, gitDir: null }
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
 * @param onUpdate - when supplied, refreshes asynchronously without blocking the event loop.
 * @returns a lookup that reads at most once per workspace and interval.
 */
export function createGitBranchReader(
  ttlMs = DEFAULT_REFRESH_MS,
  now: () => number = Date.now,
  onUpdate?: () => void,
): GitBranchReader {
  const readings = new Map<string, BranchReading>()
  const inFlight = new Set<string>()
  return (cwd: string): string | undefined => {
    const key = resolve(cwd)
    const at = now()
    const cached = readings.get(key)
    if (cached !== undefined && at - cached.readAt < ttlMs) return cached.branch
    if (onUpdate !== undefined) {
      if (!inFlight.has(key)) {
        inFlight.add(key)
        void readBranchAsync(key, cached?.gitDir).then(reading => {
          readings.set(key, { ...reading, readAt: now() })
          if (reading.branch !== cached?.branch) onUpdate()
        }).finally(() => {
          inFlight.delete(key)
        })
      }
      return cached?.branch
    }
    const reading = readBranch(key, cached?.gitDir)
    readings.set(key, { ...reading, readAt: at })
    return reading.branch
  }
}
