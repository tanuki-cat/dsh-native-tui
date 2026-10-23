/**
 * Real-Host check for the terminal's Codex route commands.
 *
 * The probe boots a scratch `tui` profile with `llm-pi-ai` from `dsh-base` and
 * drives the local `/codex` commands:
 *
 *   /codex status   -> not signed in
 *   /codex setup    -> writes the openai-codex route and verifies registration
 *   /codex models   -> lists the native pi-ai catalogue
 *
 * It never starts OAuth, so it needs no account and makes no network request.
 * Run with:
 *   node scripts/fake-tty-codex.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const home = process.env.DSH_CODEX_PROBE_HOME ?? '/tmp/dsh-native-tui-codex-home'
const profile = home + '/profiles/tui'
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile + '/node_modules', { recursive: true })
writeFileSync(profile + '/cordis.yml', '# dsh profile root\n[]\n')
writeFileSync(profile + '/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(profile + '/cordis.patch.yml', [
  '- id: native-tui',
  '  name: dsh-native-tui',
  '  config:',
  '    agentPreset: standard',
  '    runCodeDisplay: compact',
  '',
].join('\n'))
try {
  symlinkSync(process.cwd(), profile + '/node_modules/dsh-native-tui', 'dir')
}
catch (error) {
  if (error?.code !== 'EEXIST') throw error
}

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_NATIVE_TUI_NO_LAUNCHER: '1',
    COLUMNS: '120',
    LINES: '40',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', chunk => { out += String(chunk) })
child.stderr.on('data', chunk => { err += String(chunk) })

const steps = [
  [1600, '/codex status\r'],
  [3600, '/codex setup\r'],
  [9000, '/codex models\r'],
  [11200, '/codex logout\r'],
  [13600, '\x04'],
]
for (const [delay, data] of steps) setTimeout(() => { try { child.stdin.write(data) } catch {} }, delay)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)

child.on('exit', (code, signal) => {
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  let failed = 0
  const check = (name, pass, detail) => {
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass || detail === undefined ? '' : ' — ' + detail))
    if (!pass) failed += 1
  }
  check('process exits cleanly', code === 0 && signal === null, 'exit ' + String(code) + ' / ' + String(signal))
  check('status reports signed out', clean.includes('not signed in'))
  check('setup reports the route ready', clean.includes('Route openai-codex is ready'))
  check('models lists openai-codex', clean.includes('openai-codex:') && /gpt-[0-9]/.test(clean))
  check('logout reports the signed-out state', clean.includes('Codex: not signed in.'))
  check('no credential material printed', !/refresh-token|access-token/.test(clean))
  console.log('--- STDOUT (tail) ---')
  console.log(clean.slice(-16000))
  if (err !== '') {
    console.log('--- STDERR (tail) ---')
    console.log(err.slice(-4000))
  }
  process.exit(failed === 0 ? 0 : 1)
})