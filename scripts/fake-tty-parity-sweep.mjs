import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install-home', COLUMNS: '130', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const sends = [
  [1500, '/workspaces\r'],
  [3000, '/workspaces new /tmp/dsh-tui-workspace\r'],
  [4500, '/workspaces\r'],
  [6000, '/schedule add 120 test reminder\r'],
  [7500, '/schedule\r'],
  [9000, '/plugins\r'],
  [11500, '/settings\r'],
  [14500, '/workspaces use /tmp/dsh-tui-workspace\r'],
  [17500, '/status\r'],
  [20500, '\x04'],
]
for (const [delay, data] of sends) setTimeout(() => { try { child.stdin.write(data) } catch {} }, delay)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-40000))
  console.log('--- STDERR ---')
  console.log(err.slice(-12000))
  process.exit(0)
})
