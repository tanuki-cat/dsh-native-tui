import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'auto-model', name: 'Auto Model', context_length: 64000, max_tokens: 8192 },
      { id: 'auto-small', name: 'Auto Small', context_length: 16000, max_tokens: 4096 },
    ] }))
    return
  }
  res.writeHead(404); res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-install13-home', AUTO_ROUTE_API_KEY: 'dummy-key', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
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
  else if (phase === 2 && text.includes('Provider route')) { phase = 3; try { child.stdin.write('auto-route\r') } catch {} }
  else if (phase === 3 && text.includes('Base URL')) { phase = 4; try { child.stdin.write('http://127.0.0.1:' + port + '/v1\r') } catch {} }
  else if (phase === 4 && text.includes('Credential source')) { phase = 5; try { child.stdin.write('\x1b[B\r') } catch {} }
  else if (phase === 5 && text.includes('API key env var NAME')) { phase = 6; try { child.stdin.write('\r') } catch {} }
  else if (phase === 6 && text.includes('Select model from auto-route')) { phase = 7; try { child.stdin.write('\r') } catch {} }
  else if (phase === 7 && text.includes('Input modalities')) { phase = 8; try { child.stdin.write('\r') } catch {} }
  else if (phase === 8 && text.includes('Reasoning levels')) { phase = 9; try { child.stdin.write('\r') } catch {} }
  else if (phase === 9 && text.includes('Model selected: auto-route/auto-model')) {
    phase = 10
    try { child.stdin.write('/provider list\r') } catch {}
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 900)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-28000))
  console.log('--- STDERR ---')
  console.log(err.slice(-7000))
  process.exit(0)
})