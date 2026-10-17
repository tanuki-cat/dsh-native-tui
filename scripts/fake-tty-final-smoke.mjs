import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-pack30-home', COLUMNS: '130', LINES: '42', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('/preset\r') } catch {} }
  else if (phase === 1 && text.includes('Agent preset')) { phase = 2; try { child.stdin.write('\x1b') } catch {} }
  else if (phase === 2 && !text.includes('Agent preset')) { phase = 3; try { child.stdin.write('/help\r') } catch {} }
  else if (phase === 3 && text.includes('Tool calls') === false && text.includes('Host commands:')) {
    phase = 4
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-22000))
  console.log('--- STDERR ---')
  console.log(err.slice(-4000))
  process.exit(0)
})
