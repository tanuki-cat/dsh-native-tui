import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
const home = '/tmp/dsh-native-tui-esc-clear-home'
mkdirSync(home + '/profiles/tui', { recursive: true })
let requests = 0
const bodies = []
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    requests += 1
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      bodies.push(body)
      console.log('SERVER request', body.slice(0, 120))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'streaming mock output' }, finish_reason: null }],
      }) + '\n\n')
      req.on('close', () => console.log('SERVER request closed'))
    })
    return
  }
  res.writeHead(404); res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root\n[]\n')
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(home + '/profiles/tui/cordis.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: standard
    runCodeDisplay: compact
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)
// A fresh probe home needs the plugin visible to the profile loader; the
// repository checkout is the source of truth, so link it instead of installing.
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }
const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
let phase = 0
let draftSeen = false
let escAt = 0
let enterAt = 0
let promptAt = 0
const tick = setInterval(() => {
  const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    try { child.stdin.write('draft-marker') } catch {}
  }
  else if (phase === 1 && text.includes('draft-marker')) {
    draftSeen = true
    phase = 2
    escAt = Date.now()
    try { child.stdin.write('\x1b') } catch {}
  }
  else if (phase === 2 && Date.now() - escAt > 700) {
    phase = 3
    enterAt = Date.now()
    try { child.stdin.write('\r') } catch {}
  }
  else if (phase === 3 && Date.now() - enterAt > 1200) {
    phase = 4
    promptAt = Date.now()
    try { child.stdin.write('real-prompt') } catch {}
  }
  else if (phase === 4 && Date.now() - promptAt > 900) {
    phase = 5
    try { child.stdin.write('\r') } catch {}
  }
  else if (phase === 5 && requests > 0) {
    phase = 6
    try { child.stdin.write('\x04') } catch {}
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  // The Host also sends an unrelated session-title request. Counting only the
  // agent request proves that the emptied Enter sent nothing and the draft did
  // not stick to the following prompt.
  const mainRequests = bodies.filter(body => body.includes('You are an AI agent powered by DeepSeek Harness'))
  const firstPrompt = mainRequests.length === 1
    && mainRequests[0].includes('real-prompt')
    && !mainRequests[0].includes('draft-marker')
  const pass = draftSeen && firstPrompt
  console.log('EXIT', code, signal, 'phase', phase, 'draftSeen', draftSeen, 'requests', requests, 'mainRequests', mainRequests.length, 'firstPrompt', firstPrompt, 'pass', pass)
  console.log(clean.slice(-12000))
  console.log('--- STDERR ---')
  console.log(err.slice(-4000))
  process.exit(pass ? 0 : 1)
})
