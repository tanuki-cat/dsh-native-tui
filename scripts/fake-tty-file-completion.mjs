/**
 * Real-Host check that `@file` suggestions survive long, shared path prefixes.
 *
 * The repo's docs/ folder holds many `design-task-*` files whose names begin
 * identically. The menu must render each row as "basename  full/path" (as pi's
 * file completion does), so the distinguishing tail of the name is not eaten by
 * the shared directory prefix.
 *
 * Setup:
 *   pnpm build
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-reasoning-stream-home node scripts/fake-tty-file-completion.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-reasoning-stream-home'
if (!existsSync(home + '/profiles/tui')) {
  console.error('Install a TUI profile at ' + home + ' first.')
  process.exit(2)
}

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, COLUMNS: '130', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

let sent = false
const tick = setInterval(() => {
  const text = strip(out)
  if (!sent && text.includes('enter send')) {
    sent = true
    try { child.stdin.write('@docs/design') } catch {}
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 2600)
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 12000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  // Rows render as "<name column>  docs/design-task-....md".
  const rows = text.split('\n').filter(line => /docs\/design-task-[^\s]+\.md/.test(line) && !line.includes('@docs/design'))
  const named = rows.filter(line => /^\s*(→\s+)?design-task-/.test(line))
  // The name column must not repeat the docs/ prefix: that is what forced every
  // row to truncate at the same place before.
  const prefixedNames = rows.filter(line => /^\s*(→\s+)?docs\/design-task-/.test(line))
  const pass = rows.length > 0 && named.length === rows.length && prefixedNames.length === 0
  console.log('EXIT', code, signal)
  console.log('rows', rows.length, 'named', named.length, 'prefixedNames', prefixedNames.length)
  console.log(rows.slice(0, 4).join('\n'))
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-8000))
    console.log('--- stderr tail ---')
    console.log(err.slice(-2000))
  }
  process.exit(pass ? 0 : 1)
})
