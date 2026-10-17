import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install13-home', TEST_ROUTE_API_KEY: 'dummy-key', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
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
  else if (phase === 2 && text.includes('Provider route')) { phase = 3; try { child.stdin.write('test-route\r') } catch {} }
  else if (phase === 3 && text.includes('Base URL')) { phase = 4; try { child.stdin.write('https://example.invalid/v1\r') } catch {} }
  else if (phase === 4 && text.includes('Credential source')) { phase = 5; try { child.stdin.write('\x1b[B\r') } catch {} }
  else if (phase === 5 && text.includes('API key env var NAME')) { phase = 6; try { child.stdin.write('\r') } catch {} }
  else if (phase === 6 && text.includes('Model id')) { phase = 7; try { child.stdin.write('test-model\r') } catch {} }
  else if (phase === 7 && text.includes('Context window')) { phase = 8; try { child.stdin.write('\r') } catch {} }
  else if (phase === 8 && text.includes('Max output tokens')) { phase = 9; try { child.stdin.write('\r') } catch {} }
  else if (phase === 9 && text.includes('Input modalities')) { phase = 10; try { child.stdin.write('\r') } catch {} }
  else if (phase === 10 && text.includes('Reasoning levels')) { phase = 11; try { child.stdin.write('\r') } catch {} }
  else if (phase === 11 && text.includes('Model selected')) {
    phase = 12
    setTimeout(() => { try { child.stdin.write('/provider list\r') } catch {} }, 500)
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 1300)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-30000))
  console.log('--- STDERR ---')
  console.log(err.slice(-8000))
  process.exit(0)
})