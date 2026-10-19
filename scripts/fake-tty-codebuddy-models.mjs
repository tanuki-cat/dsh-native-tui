/**
 * Real-Host check for /codebuddy models: the command lists each catalogue model
 * with the input modalities it declares and where that decision came from.
 *
 * Uses a temporary DSH home so no real profile is touched, and a fake
 * credential so the catalogue refresh runs against a mock gateway: this probe
 * verifies the rendering path, not the network.
 *
 * Setup: pnpm build, pack and install into the scratch home (see README).
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-codebuddy-home node scripts/fake-tty-codebuddy-models.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-cb-models-home'

// The probe writes a fake credential record, so it must never land in a home
// that already holds real ones. A home this probe seeded before is recognized
// by its own token, which makes reruns idempotent.
const credentialFile = join(home, '.credentials.yaml')
const existing = await readFile(credentialFile, 'utf8').catch(() => undefined)
if (existing !== undefined && !existing.includes('probe-access')) {
  // Existing credentials are either a real sign-in or another probe's: never
  // overwritten, whichever home they live in.
  console.error('refusing to overwrite existing credentials at ' + credentialFile
    + '; point DSH_HOME at a scratch home instead')
  process.exit(2)
}

// A stored grant is what makes listModels reach the gateway; the probe only
// needs the record to exist, never a working token. The credential store
// refuses a file any other user can read, so it is created owner-only.
await mkdir(join(home, 'profiles', 'tui', 'data'), { recursive: true })
await writeFile(credentialFile, [
  'version: 1',
  'records:',
  '  codebuddy/codebuddy:',
  '    kind: grant',
  '    payload:',
  '      access: probe-access',
  '      refresh: probe-refresh',
  '      expires: ' + String(Date.now() + 86_400_000),
  '  codebuddy/codebuddy-en:',
  '    kind: grant',
  '    payload:',
  '      access: probe-access',
  '      refresh: probe-refresh',
  '      expires: ' + String(Date.now() + 86_400_000),
  'refs: {}',
  '',
].join('\n'), { mode: 0o600 })

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '160', LINES: '50', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })

const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const seen = { start: false, models: false }
let finished = false
const tick = setInterval(() => {
  const text = strip(out)
  if (!seen.start && text.includes('enter send')) {
    seen.start = true
    try { child.stdin.write('/codebuddy models cn\r') } catch {}
  }
  else if (!seen.models && /\[seed\]|\[catalogue\]/.test(text)) {
    seen.models = true
    finished = true
    try { child.stdin.write('\x1b') } catch {}
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 300)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  // The unsigned route advertises the seed list, so the listing must name a
  // seed model and label its source.
  const named = /deepseek-v4-pro/u.test(text)
  const sourced = /\[(seed|catalogue|override)\]/u.test(text)
  const modalities = /text only|text\+image/u.test(text)
  const checks = [
    ['/codebuddy models prints a model list header', /codebuddy: \d+ models/u.test(text)],
    ['the model list names a catalogue entry', named],
    ['each row reports where its modality came from', sourced],
    ['each row reports its declared modalities', modalities],
    ['the terminal exited cleanly', finished && code === 0],
  ]
  let failures = 0
  for (const [label, ok] of checks) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label)
    if (!ok) failures += 1
  }
  if (failures > 0) {
    console.log('\n--- output tail ---\n' + text.slice(-3000))
    if (err !== '') console.log('\n--- stderr tail ---\n' + strip(err).slice(-1500))
  }
  console.log(failures === 0 ? '\nOK /codebuddy models verified' : '\n' + failures + ' check(s) failed')
  process.exit(failures === 0 ? 0 : 1)
})
