import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install-home', COLUMNS: '150', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let sent = false
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (!sent && text.includes('enter send')) {
    sent = true
    try { child.stdin.write('/plugins list\r') } catch {}
  } else if (sent && text.includes('Plugin entries')) {
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 250)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 12000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-32000))
  console.log('--- STDERR ---')
  console.log(err.slice(-5000))
  process.exit(0)
})
