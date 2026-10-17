import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install-home', COLUMNS: '130', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const sends = [
  [1500, '/attach README.md\r'],
  [3500, '/attach list\r'],
  [5000, 'hello\r'],
  [12000, '/attach clear\r'],
  [13500, '\x04'],
]
for (const [delay, data] of sends) setTimeout(() => { try { child.stdin.write(data) } catch {} }, delay)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 18000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-26000))
  console.log('--- STDERR ---')
  console.log(err.slice(-8000))
  process.exit(0)
})
