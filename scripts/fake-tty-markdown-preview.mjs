import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install13-home', COLUMNS: '130', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    try { child.stdin.write('/open /tmp/native-tui-rich.md\r') } catch {}
  } else if (phase === 1 && text.includes('Markdown ·')) {
    phase = 2
    setTimeout(() => { try { child.stdin.write('\x1b') } catch {} }, 800)
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 1600)
  }
}, 300)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 18000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-20000))
  console.log('--- STDERR ---')
  console.log(err.slice(-5000))
  process.exit(0)
})
