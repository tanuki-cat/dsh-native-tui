import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const home = '/tmp/dsh-native-tui-reload-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write('data: ' + JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'mocked' }, finish_reason: null }],
    }) + '\n\n')
    return
  }
  res.writeHead(404)
  res.end('not found')
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
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let out = '', err = '', phase = 0, sessionId, reloadedAt = 0
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    sessionId = text.match(/native-tui-[0-9a-f-]+/)?.[0]
    phase = 1
    child.stdin.write('/reload\r')
    return
  }
  if (phase === 1) {
    const marker = text.indexOf('Reloading dsh')
    if (marker !== -1 && text.slice(marker).includes('enter send')) {
      phase = 2
      reloadedAt = Date.now()
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 700)
    }
  }
}, 300)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  server.close()
  const clean = strip(out)
  const models = [...clean.matchAll(/● idle   model ([^ ]+)/g)].map(match => match[1])
  const lines = clean.split('\n').filter(line => line.startsWith('Session:') || line.startsWith('Resume:'))
  const lastSession = [...lines].reverse().find(line => line.startsWith('Session:'))
  const pass = code === 0
    && phase === 2
    && sessionId !== undefined
    && lastSession === 'Session: ' + sessionId
    && models.length >= 2
    && models.every(model => model === 'mock/mock-model')
  console.log('EXIT', code, signal, 'phase', phase, 'session', sessionId, 'models', models.join(' -> '), 'pass', pass, 'reloadedIn', reloadedAt === 0 ? '-' : Date.now() - reloadedAt)
  console.log(lines.join('\n'))
  console.log(clean.slice(-1500))
  console.log('--- STDERR ---')
  console.log(err.slice(-2000))
  process.exit(pass ? 0 : 1)
})
