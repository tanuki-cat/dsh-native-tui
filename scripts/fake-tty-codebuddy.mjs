/**
 * Real-Host check that the built-in codebuddy plugin mounts in the terminal
 * profile and drives the /codebuddy command surface:
 *
 *   1. /codebuddy status reports both deployments as not signed in
 *   2. /codebuddy doctor prints the transcribed endpoints without network
 *   3. /model lists the two routes and their seed models
 *
 * No gateway and no account are needed: every check here is offline-safe, so
 * this probe can run anywhere. A signed-in catalogue and a real chat turn are
 * deliberately out of scope (they need an account).
 *
 * Setup (installs this repo's current build into a scratch home):
 *   pnpm build
 *   pnpm pack --pack-destination .tmp
 *   DSH_HOME=/tmp/dsh-native-tui-codebuddy-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
 *
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-codebuddy-home node scripts/fake-tty-codebuddy.mjs
 */
import { spawn } from 'node:child_process'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-codebuddy-home'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })

const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const seen = { start: false, status: false, doctor: false }
let finished = false
const tick = setInterval(() => {
  const text = strip(out)
  if (!seen.start && text.includes('enter send')) {
    seen.start = true
    try { child.stdin.write('/codebuddy status\r') } catch {}
  }
  else if (!seen.status && text.includes('codebuddy-en: not signed in')) {
    seen.status = true
    try { child.stdin.write('/codebuddy doctor\r') } catch {}
  }
  else if (!seen.doctor && text.includes('probe: credential refused')) {
    seen.doctor = true
    try { child.stdin.write('/model\r') } catch {}
  }
  else if (seen.doctor && !finished && text.includes('codebuddy/deepseek-v4-pro')) {
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
  const checks = [
    ['/codebuddy is a local command', text.includes('codebuddy: not signed in')],
    ['both deployments report status', text.includes('codebuddy-en: not signed in')],
    ['seed catalogue is advertised', text.includes('8 models, catalogue refreshed never')
      && text.includes('6 models, catalogue refreshed never')],
    ['doctor prints the chat endpoint', text.includes('copilot.tencent.com/v2')
      && text.includes('www.workbuddy.ai/console')],
    ['doctor reports the sign-in probe', text.includes('probe: credential refused')],
    ['/model lists the cn route', text.includes('codebuddy/deepseek-v4-pro')],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + ' ' + label)
  console.log('EXIT ' + String(code) + ' finished=' + String(finished) + ' seen=' + JSON.stringify(seen))
  if (failed.length > 0) {
    console.log(text.slice(-6000))
    console.log('--- STDERR ---')
    console.log(err.slice(-3000))
  }
  console.log(failed.length === 0 && finished ? 'OK built-in codebuddy plugin verified' : 'FAILED ' + String(failed.length) + ' check(s)')
  process.exit(failed.length === 0 && finished ? 0 : 1)
})
