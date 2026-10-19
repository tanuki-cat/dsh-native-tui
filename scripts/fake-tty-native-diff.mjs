import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
mkdirSync('.tmp', { recursive: true })
rmSync('.tmp/native-diff-demo.txt', { force: true })
const home = '/tmp/dsh-native-tui-native-diff-home'
mkdirSync(home + '/profiles/tui', { recursive: true })

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const isTitle = JSON.stringify(parsed).includes('Create a concise title')
      const toolMessages = messages.filter(message => message.role === 'tool').length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n')
      const base = () => ({ id: 'chatcmpl-native-diff', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
      send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      if (isTitle) {
        send({ ...base(), choices: [{ index: 0, delta: { content: 'Native diff E2E' }, finish_reason: null }] })
      }
      else if (toolMessages === 0) {
        send({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: 'call-native-write',
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ file_path: '.tmp/native-diff-demo.txt', content: 'before' }) },
        }] }, finish_reason: null }] })
        send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      }
      else if (toolMessages === 1) {
        send({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: 'call-native-edit',
          type: 'function',
          function: { name: 'edit', arguments: JSON.stringify({ file_path: '.tmp/native-diff-demo.txt', old_string: 'before', new_string: 'after' }) },
        }] }, finish_reason: null }] })
        send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      }
      else {
        send({ ...base(), choices: [{ index: 0, delta: { content: 'NATIVE DIFF DONE' }, finish_reason: null }] })
      }
      send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

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
    runCodeDisplay: detailed
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '130', LINES: '50', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let phase = 0
let seenAt = 0
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) { phase = 1; try { child.stdin.write('run the native diff probe\r') } catch {} }
  else if (phase === 1 && text.includes('│ + after')) { phase = 2; seenAt = Date.now() }
  else if (phase === 2 && Date.now() - seenAt > 800) { phase = 3; try { child.stdin.write('\x04') } catch {} }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const clean = strip(out)
  const pass = clean.includes('⚙ write')
    && clean.includes('⚙ edit')
    && clean.includes('├ diff')
    && clean.includes('│ + before')
    && clean.includes('│ - before')
    && clean.includes('│ + after')
    && !clean.includes('⚙ run_code')
  console.log('EXIT', code, signal, 'phase', phase, 'pass', pass)
  console.log(clean.slice(-14000))
  console.log('--- STDERR ---')
  console.log(err.slice(-4000))
  process.exit(0)
})
