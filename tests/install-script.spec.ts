import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface InstallerFixture {
  readonly root: string
  readonly launcher: string
  readonly log: string
  run(...args: string[]): SpawnSyncReturns<string>
  runWith(env: NodeJS.ProcessEnv, ...args: string[]): SpawnSyncReturns<string>
}

function fixture(): InstallerFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  cleanup.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  const script = join(repo, 'scripts', 'install.sh')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  mkdirSync(dirname(script), { recursive: true })
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(repoRoot, 'scripts', 'install.sh'), script)
  writeFileSync(join(repo, 'dist', 'index.js'), '// fixture\n')

  const log = join(root, 'dsh.log')
  for (const name of ['dsh', 'pnpm']) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n`)
    chmodSync(path, 0o755)
  }

  const runWith = (extra: NodeJS.ProcessEnv, ...args: string[]): SpawnSyncReturns<string> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DSH_HOME: join(home, '.dsh'),
      ...extra,
    }
    if (extra.XDG_BIN_HOME === undefined) delete env.XDG_BIN_HOME
    return spawnSync('bash', [script, '--no-build', ...args], { cwd: repo, encoding: 'utf8', env })
  }

  return {
    root,
    launcher: join(home, '.local', 'bin', 'dnt'),
    log,
    run: (...args: string[]) => runWith({}, ...args),
    runWith,
  }
}

describe('scripts/install.sh launcher', () => {
  it('installs an executable dnt command that forwards arguments', () => {
    const f = fixture()
    const result = f.run()
    expect(result.status, result.stderr).toBe(0)

    const text = readFileSync(f.launcher, 'utf8')
    expect(text).toContain("exec dsh --profile 'tui' \"$@\"")
    expect(statSync(f.launcher).mode & 0o111).not.toBe(0)

    const launched = spawnSync(f.launcher, ['--resume', 'abc'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH ?? ''}` },
    })
    expect(launched.status, launched.stderr).toBe(0)
    expect(readFileSync(f.log, 'utf8')).toContain('dsh --profile tui --resume abc')
  })

  it('uses a profile suffix for non-tui profiles', () => {
    const f = fixture()
    const result = f.run('--profile', 'work')
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(f.root, 'home', '.local', 'bin', 'dnt-work'), 'utf8'))
      .toContain("exec dsh --profile 'work'")
    expect(existsSync(f.launcher)).toBe(false)
  })

  it('accepts an explicit command name', () => {
    const f = fixture()
    const result = f.run('--profile', 'work', '--command', 'work-tui')
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(f.root, 'home', '.local', 'bin', 'work-tui'), 'utf8'))
      .toContain("exec dsh --profile 'work'")
  })

  it('skips the command with DSH_NATIVE_TUI_NO_LAUNCHER=1', () => {
    const f = fixture()
    const result = f.runWith({ DSH_NATIVE_TUI_NO_LAUNCHER: '1' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(f.launcher)).toBe(false)
  })

  it('does not overwrite a foreign file', () => {
    const f = fixture()
    writeFileSync(f.launcher, '#!/bin/sh\necho foreign\n')
    const result = f.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('already exists')
    expect(readFileSync(f.launcher, 'utf8')).toContain('foreign')
  })

  it('replaces a launcher it created on a later install', () => {
    const f = fixture()
    expect(f.run().status).toBe(0)
    expect(f.run('--profile', 'work', '--command', 'dnt').status).toBe(0)
    expect(readFileSync(f.launcher, 'utf8')).toContain("exec dsh --profile 'work'")
  })
})
