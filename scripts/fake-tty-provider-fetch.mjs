import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
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
writeFileSync('/tmp/dsh-native-tui-fetch-home/profiles/tui/cordis.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      fetch-route:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: FETCH_KEY
        models:
          - id: auto-model
            name: Auto Model
            contextWindow: 64000
            maxTokens: 8192
`)
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: '/tmp/dsh-native-tui-fetch-home', FETCH_KEY: 'dummy', COLUMNS: '140', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('/provider models fetch-route\r') } catch {} }
  else if (phase === 1 && text.includes('Fetched 2 model(s) for fetch-route')) {
    phase = 2
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 900)
  }
}, 350)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  console.log('EXIT', code, signal, 'phase', phase)
  console.log(clean.slice(-22000))
  console.log('--- STDERR ---')
  console.log(err.slice(-5000))
  process.exit(0)
})
