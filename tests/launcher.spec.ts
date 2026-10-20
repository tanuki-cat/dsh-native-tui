import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureLauncher, findLauncher, launcherName, launcherScript, parseProfileArg, resumeHint } from '../src/runtime/launcher.js'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
  cleanup.push(root)
  return root
}

function envFor(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: join(root, 'home'), XDG_BIN_HOME: join(root, 'bin'), ...extra }
}

describe('launcher profile parsing', () => {
  it('accepts the flag, the equals form, and the shorthand', () => {
    expect(parseProfileArg(['--profile', 'tui'])).toBe('tui')
    expect(parseProfileArg(['--profile=tui'])).toBe('tui')
    expect(parseProfileArg(['tui', '--resume', 'abc'])).toBe('tui')
  })

  it('returns undefined without an explicit profile', () => {
    expect(parseProfileArg([])).toBeUndefined()
    expect(parseProfileArg(['--patch', 'extra.yml'])).toBeUndefined()
    expect(parseProfileArg(['--profile'])).toBeUndefined()
  })
})

describe('launcher naming and content', () => {
  it('gives tui the dnt command and suffixes other profiles', () => {
    expect(launcherName('tui')).toBe('dnt')
    expect(launcherName('work')).toBe('dnt-work')
  })

  it('forwards every argument to the profile app', () => {
    const script = launcherScript('tui')
    expect(script).toContain('# dsh-native-tui launcher: run the "tui" profile.')
    expect(script).toContain("exec dsh --profile 'tui' \"$@\"")
  })
})

describe('ensureLauncher', () => {
  it('creates an executable launcher and leaves it alone next time', async () => {
    const root = tempRoot()
    const env = envFor(root)
    const first = await ensureLauncher('tui', env)
    expect(first.status).toBe('created')
    const path = join(root, 'bin', 'dnt')
    expect(readFileSync(path, 'utf8')).toBe(launcherScript('tui'))
    expect(statSync(path).mode & 0o111).not.toBe(0)

    expect((await ensureLauncher('tui', env)).status).toBe('current')
  })

  it('forwards arguments through the generated file', async () => {
    const root = tempRoot()
    const env = envFor(root)
    await ensureLauncher('tui', env)
    const stub = join(root, 'stub')
    mkdirSync(stub, { recursive: true })
    const log = join(root, 'dsh.log')
    const dsh = join(stub, 'dsh')
    writeFileSync(dsh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`)
    chmodSync(dsh, 0o755)

    const result = spawnSync(join(root, 'bin', 'dnt'), ['--resume', 'abc'], {
      encoding: 'utf8',
      env: { PATH: `${stub}:${process.env.PATH ?? ''}` },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('--profile tui --resume abc\n')
  })

  it('never replaces a foreign command', async () => {
    const root = tempRoot()
    const env = envFor(root)
    const path = join(root, 'bin', 'dnt')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\necho foreign\n')

    const outcome = await ensureLauncher('tui', env)
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'foreign file' })
    expect(readFileSync(path, 'utf8')).toContain('foreign')
  })

  it('recognizes a custom-named launcher for the same profile', async () => {
    const root = tempRoot()
    const env = envFor(root)
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'dst'), launcherScript('tui'))

    const outcome = await ensureLauncher('tui', env)
    expect(outcome).toMatchObject({ status: 'current', path: join(root, 'bin', 'dst') })
    expect(existsSync(join(root, 'bin', 'dnt'))).toBe(false)
  })

  it('skips throwaway DSH homes, opt-outs, and unsafe names', async () => {
    const root = tempRoot()
    expect((await ensureLauncher('tui', envFor(root, { DSH_HOME: join(root, 'dsh') }))).status).toBe('skipped')
    expect((await ensureLauncher('tui', envFor(root, { DSH_NATIVE_TUI_NO_LAUNCHER: '1' }))).status).toBe('skipped')
    expect((await ensureLauncher('../tui', envFor(root))).status).toBe('skipped')
    expect(existsSync(join(root, 'bin', 'dnt'))).toBe(false)
  })
})

describe('launcher lookup and resume hint', () => {
  it('finds the default and the custom-named launcher', async () => {
    const root = tempRoot()
    const env = envFor(root)
    await ensureLauncher('tui', env)
    expect(await findLauncher('tui', env)).toBe(join(root, 'bin', 'dnt'))

    writeFileSync(join(root, 'bin', 'dst'), launcherScript('tui'))
    rmSync(join(root, 'bin', 'dnt'))
    expect(await findLauncher('tui', env)).toBe(join(root, 'bin', 'dst'))
  })

  it('ignores foreign commands and missing profiles', async () => {
    const root = tempRoot()
    const env = envFor(root)
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'dnt'), '#!/bin/sh\necho foreign\n')
    expect(await findLauncher('tui', env)).toBeUndefined()
    expect(await findLauncher(undefined, env)).toBeUndefined()
  })

  it('prints the launcher when present and the explicit command otherwise', () => {
    expect(resumeHint('tui', '/home/u/.local/bin/dnt', 's1')).toBe('dnt --resume s1')
    expect(resumeHint('work', '/home/u/.local/bin/dnt-work', 's1')).toBe('dnt-work --resume s1')
    expect(resumeHint('work', undefined, 's1')).toBe('dsh --profile work --resume s1')
    expect(resumeHint(undefined, undefined, 's1')).toBe('dsh --profile tui --resume s1')
    expect(resumeHint('../x', undefined, 's1')).toBe('dsh --profile tui --resume s1')
  })
})
