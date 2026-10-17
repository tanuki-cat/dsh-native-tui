import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? '/tmp/dsh-native-tui-home', COLUMNS: '110', LINES: '34', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let selected = false
let exited = false
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (!selected && text.includes('Pick one')) {
    selected = true
    try { child.stdin.write('\r') } catch {}
  }
  if (selected && !exited && err.includes('QUESTION_PROBE_ANSWER')) {
    exited = true
    try { child.stdin.write('\x04') } catch {}
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'selected', selected)
  console.log(clean.slice(-16000))
  console.log('--- STDERR ---')
  console.log(err.slice(-12000))
  process.exit(0)
})
