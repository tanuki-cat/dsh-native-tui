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

const steps = [
  { wait: 'enter send', send: '/help\r', label: 'help' },
  { wait: 'Local commands', send: '/status\r', label: 'status' },
  { wait: 'Session:', send: '/sessions\r', label: 'sessions' },
  { wait: 'Sessions:', send: 'hello\r', label: 'prompt' },
  { wait: 'Turn failed', send: '\x04', label: 'exit-after-failure' },
]
let index = 0
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const step = steps[index]
  if (step !== undefined && text.includes(step.wait)) {
    index += 1
    try { child.stdin.write(step.send) } catch {}
  }
}, 150)
setTimeout(() => {
  if (index < steps.length) {
    try { child.stdin.write('\x04') } catch {}
  }
}, 24000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  clearInterval(tick)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'steps', index + '/' + steps.length)
  console.log('--- STDOUT ---')
  console.log(clean.slice(-24000))
  console.log('--- STDERR ---')
  console.log(err.slice(-8000))
  process.exit(0)
})
