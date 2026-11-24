import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert(args.length === 0 || (args.length === 2 && args[0] === '--version'), 'Usage: registry-install-smoke.mjs [--version <exact version>]')
const version = args[1] ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u)

const temp = fileURLToPath(new URL('../.tmp/', import.meta.url))
mkdirSync(temp, { recursive: true })
const root = mkdtempSync(join(temp, 'registry-install-'))
const manifest = join(root, 'package.json')
writeFileSync(manifest, JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': version } }))
writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n@deepseek-ai:registry=https://registry.npmjs.org/\n')
writeFileSync(join(root, 'pnpm-workspace.yaml'), `allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  koffi: true
  node-pty: true
  protobufjs: false
`)
const env = { ...process.env, DSH_HOME: join(root, 'home'), XDG_CACHE_HOME: join(root, 'cache') }
const run = (exe, argv) => execFileSync(exe, argv, { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
const loader = '@deepseek-ai/cordis-plugin-loader'

try {
  run('pnpm', ['install', '--store-dir', join(root, 'store'), '--config.minimum-release-age=0'])
  const cli = createRequire(manifest).resolve('@deepseek-ai/dsh/package.json')
  const meta = JSON.parse(readFileSync(cli, 'utf8'))
  assert.equal(meta.version, version)
  const requireCli = createRequire(cli)
  const boot = requireCli.resolve('@deepseek-ai/dsh-app-boot')
  const entry = fileURLToPath(new URL(meta.bin.dsh, pathToFileURL(cli)))
  for (const importer of [cli, boot]) {
    const resolved = createRequire(importer).resolve(loader)
    const exported = await import(pathToFileURL(resolved).href)
    assert.equal(typeof exported.EntryValidationError, 'function', `${importer} resolves ${resolved} without EntryValidationError`)
    console.error(`${importer} resolves ${resolved}`)
  }
  assert.equal(run(process.execPath, [entry, '--version']).trim(), version)
  console.log(entry)
} catch (error) {
  console.error('Registry smoke evidence:', root)
  if (error.stdout) console.error(error.stdout.trim().split('\n').slice(-15).join('\n'))
  try { console.error(run('pnpm', ['list', '--depth', '1'])) } catch {}
  throw new Error(error.stderr?.trim() || error.message)
}
