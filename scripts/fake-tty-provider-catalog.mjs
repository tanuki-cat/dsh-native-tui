/**
 * Real-Host check that /provider add exposes the shipped pi-ai catalog the same
 * way the Web editor does:
 *
 *   1. "Built-in pi-ai catalog route" opens a searchable provider list
 *   2. the provider's native credential env is the default reference
 *   3. "Use built-in environment auth" saves a reference-free profile
 *   4. the shipped model list then drives the model picker
 *
 * Idempotent: a route this check saved earlier is replaced through the
 * existing-route confirmation.
 *
 * Setup (installs this repo's current build into a scratch home):
 *   pnpm pack --pack-destination .tmp
 *   DSH_HOME=/tmp/dsh-native-tui-catalog-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
 *
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-catalog-home node scripts/fake-tty-provider-catalog.mjs
 */
import { spawn } from 'node:child_process'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-catalog-home'
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
const seen = { start: false, type: false, picker: false, credential: false, replace: false, model: false }
let finished = false
const tick = setInterval(() => {
  const text = strip(out)
  if (!seen.start && text.includes('enter send')) {
    seen.start = true
    try { child.stdin.write('/provider add\r') } catch {}
  }
  else if (!seen.type && text.includes('Provider type')) {
    seen.type = true
    // Fourth row of the provider-type list: Built-in pi-ai catalog route.
    try { child.stdin.write('\x1b[B\x1b[B\x1b[B\r') } catch {}
  }
  else if (!seen.picker && text.includes('Built-in provider')) {
    seen.picker = true
    try { child.stdin.write('bedrock') } catch {}
    setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 500)
  }
  else if (!seen.credential && text.includes('Credential source')) {
    seen.credential = true
    // First row when the provider reports native auth: Use built-in environment auth.
    try { child.stdin.write('\r') } catch {}
  }
  else if (!seen.replace && text.includes('already exists')) {
    seen.replace = true
    // First row of the existing-route confirmation: Replace credential.
    try { child.stdin.write('\r') } catch {}
  }
  else if (!seen.model && text.includes('Model for amazon-bedrock')) {
    seen.model = true
    finished = true
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 800)
  }
}, 300)

const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const checks = [
    ['provider-type catalog option', text.includes('Built-in pi-ai catalog route')],
    ['searchable catalog picker', text.includes('Built-in provider') && text.includes('amazon-bedrock')],
    ['native auth option', text.includes('Use built-in environment auth')],
    ['native credential env', text.includes('AWS_BEARER_TOKEN_BEDROCK')],
    ['shipped model picker after save', text.includes('Model for amazon-bedrock')],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + ' ' + label)
  console.log('EXIT ' + String(code) + ' finished=' + String(finished) + ' seen=' + JSON.stringify(seen))
  if (failed.length > 0) {
    console.log(text.slice(-6000))
    console.log('--- STDERR ---')
    console.log(err.slice(-3000))
  }
  console.log(failed.length === 0 && finished ? 'OK built-in provider catalog verified' : 'FAILED ' + String(failed.length) + ' check(s)')
  process.exit(failed.length === 0 && finished ? 0 : 1)
})
