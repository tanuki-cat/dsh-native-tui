import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install-home', COLUMNS: '120', LINES: '36', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const sends = [
  [1500, '/workspaces pin\r'],
  [3000, '/workspaces unpin\r'],
  [4500, '/workspaces archive native-tui-615e0c82-b034-448b-b810-8c7506854798\r'],
  [6000, '/workspaces unarchive native-tui-615e0c82-b034-448b-b810-8c7506854798\r'],
  [7500, '\x04'],
]
for (const [delay, data] of sends) setTimeout(() => { try { child.stdin.write(data) } catch {} }, delay)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 15000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-24000))
  console.log('--- STDERR ---')
  console.log(err.slice(-8000))
  process.exit(0)
})
