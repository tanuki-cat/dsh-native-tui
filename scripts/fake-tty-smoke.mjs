import { spawn } from 'node:child_process'

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: process.env.DSH_HOME ?? '/tmp/dsh-native-tui-home',
    COLUMNS: '100',
    LINES: '30',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_NATIVE_TUI_DEBUG: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
let sent = false
const sendExit = () => {
  if (sent) return
  sent = true
  try { child.stdin.write('\x04') } catch {}
}
setTimeout(sendExit, 6000)
const hard = setTimeout(() => {
  try { child.kill('SIGTERM') } catch {}
}, 15000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  console.log('EXIT', code, signal)
  console.log('--- STDOUT ---')
  console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-20000))
  console.log('--- STDERR ---')
  console.log(err.slice(-20000))
  process.exit(0)
})
