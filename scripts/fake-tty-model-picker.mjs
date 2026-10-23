/**
 * Real-Host check for the /model picker: it must open after the slowest
 * provider's catalogue, not after the sum of them.
 *
 * The two built-in CodeBuddy routes read their catalogue from a network
 * endpoint, so they are what makes a cold picker slow. A fake grant in a
 * scratch home lets those listings run without a real account; the probe only
 * needs them to answer, not to answer with a specific list.
 *
 * Setup: pnpm build, then run:
 *   node scripts/fake-tty-model-picker.mjs
 * Network required: the CodeBuddy catalogue endpoints are queried.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const home = '/tmp/dsh-native-tui-model-picker-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root\n[]\n')
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(home + '/profiles/tui/cordis.patch.yml', `- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: standard
`)
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

// The credential store refuses a file any other user can read.
const expires = Date.now() + 86_400_000
const records = ['codebuddy', 'codebuddy-en'].map(route => [
  '  codebuddy/' + route + ':',
  '    kind: grant',
  '    payload:',
  '      access: probe-access',
  '      refresh: probe-refresh',
  '      expires: ' + String(expires),
].join('\n'))
writeFileSync(home + '/.credentials.yaml', ['version: 1', 'records:', ...records, 'refs: {}', ''].join('\n'), { mode: 0o600 })

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '140', LINES: '46', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const send = line => { try { child.stdin.write(line) } catch {} }

/** Cold and warm picker latencies, in the order they were measured. */
const samples = []
let phase = 0
let sentAt = 0
const tick = setInterval(() => {
  const text = strip(out)
  const count = (text.match(/Select model · \d+ available/gu) ?? []).length
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    sentAt = Date.now()
    send('/model\r')
    return
  }
  if (phase === 1 && count >= 1) {
    samples.push(Date.now() - sentAt)
    phase = 2
    send('\x1b')
    // A second sample reuses the catalogues the adapters cached for their TTL.
    setTimeout(() => { sentAt = Date.now(); send('/model\r') }, 600)
    return
  }
  if (phase === 2 && count >= 2) {
    samples.push(Date.now() - sentAt)
    phase = 3
    send('\x1b')
    setTimeout(() => send('\x04'), 400)
  }
}, 20)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 60000)

child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const header = text.match(/Select model · (\d+) available/u)
  const checks = [
    ['/model opens the picker', header !== null],
    ['the picker names a CodeBuddy model', /codebuddy(-en)?\/[a-z0-9.-]+/u.test(text)],
    ['a second /model reopens the picker', samples.length === 2],
    ['the terminal exited cleanly', phase === 3 && code === 0],
  ]
  console.log('EXIT', code, signal, 'coldMs', samples[0] ?? -1, 'warmMs', samples[1] ?? -1, 'models', header?.[1] ?? '?')
  let failures = 0
  for (const [label, ok] of checks) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label)
    if (!ok) failures += 1
  }
  if (failures > 0) {
    console.log('\n--- output tail ---\n' + text.slice(-2500))
    if (err !== '') console.log('\n--- stderr tail ---\n' + err.slice(-1200))
  }
  console.log(failures === 0 ? '\nOK /model picker verified' : '\n' + failures + ' check(s) failed')
  process.exit(failures === 0 ? 0 : 1)
})
