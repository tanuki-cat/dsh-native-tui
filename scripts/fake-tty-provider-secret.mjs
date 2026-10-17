import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install13-home', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('/provider add\r') } catch {} }
  else if (phase === 1 && text.includes('Provider type')) { phase = 2; try { child.stdin.write('\r') } catch {} }
  else if (phase === 2 && text.includes('Provider route')) { phase = 3; try { child.stdin.write('bad-route\r') } catch {} }
  else if (phase === 3 && text.includes('Base URL')) { phase = 4; try { child.stdin.write('https://example.invalid/v1\r') } catch {} }
  else if (phase === 4 && text.includes('Credential source')) { phase = 5; try { child.stdin.write('\x1b[B\r') } catch {} }
  else if (phase === 5 && text.includes('API key env var NAME')) { phase = 6; try { child.stdin.write('sk-proj-ABC123\r') } catch {} }
  else if (phase === 6 && text.includes('must be an UPPERCASE environment variable name')) {
    phase = 7
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-20000))
  console.log('--- STDERR ---')
  console.log(err.slice(-5000))
  process.exit(0)
})