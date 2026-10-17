import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? '/tmp/dsh-native-tui-home', COLUMNS: '120', LINES: '36', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const sends = [
  [1500, '/model\r'],
  [3500, '\x1b'],
  [4500, '/permissions\r'],
  [6500, '\x1b'],
  [7500, '/jobs\r'],
  [9000, '/agents\r'],
  [10500, '/status\r'],
  [12000, 'hello\r'],
  [19000, '\x04'],
]
for (const [delay, data] of sends) setTimeout(() => { try { child.stdin.write(data) } catch {} }, delay)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 28000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-30000))
  console.log('--- STDERR ---')
  console.log(err.slice(-12000))
  process.exit(0)
})
