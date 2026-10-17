import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install13-home', COLUMNS: '130', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
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
    try { child.stdin.write('/export zip /tmp/native-tui-export21.zip\r') } catch {}
  } else if (sent && text.includes('Exported ZIP bundle')) {
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 300)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal)
  console.log(clean.slice(-18000))
  console.log('--- STDERR ---')
  console.log(err.slice(-6000))
  process.exit(0)
})
