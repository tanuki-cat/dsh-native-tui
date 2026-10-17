import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-reasoning-home', MOCK_API_KEY: 'dummy', COLUMNS: '130', LINES: '42', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('/provider list\r') } catch {} }
  else if (phase === 1 && text.includes('Configured third-party providers')) { phase = 2; try { child.stdin.write('/model mock/mock-model\r') } catch {} }
  else if (phase === 2 && text.includes('Reasoning efforts: low, medium, high')) { phase = 3; try { child.stdin.write('/reasoning high\r') } catch {} }
  else if (phase === 3 && text.includes('Reasoning effort: high')) { phase = 4; try { child.stdin.write('/status\r') } catch {} }
  else if (phase === 4 && text.includes('Reasoning: high')) { phase = 5; try { child.stdin.write('hello\r') } catch {} }
  else if (phase === 5 && (text.includes('Turn failed') || text.includes('● idle'))) {
    phase = 6
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 900)
  }
}, 400)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard)
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const pos = (needle) => clean.indexOf(needle)
  console.log('EXIT', code, signal, 'phase', phase, 'positions', {
    provider: pos('Configured third-party providers'),
    model: pos('Model selected: mock/mock-model'),
    reasoning: pos('Reasoning effort: high'),
    status: pos('Session: native-tui'),
    user: pos('▌ You'),
    context: pos('◇ context'),
    failure: pos('Turn failed'),
  })
  console.log(clean.slice(-22000))
  console.log('--- STDERR ---')
  console.log(err.slice(-4000))
  process.exit(0)
})
