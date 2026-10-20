import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const NL = String.fromCharCode(10).repeat(2)
const home = '/tmp/dsh-native-tui-main-screen-scroll-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })

// Turn 1 fills the transcript past the viewport, so turn 2 streams with its
// assistant head already scrolled into scrollback.
const paragraphs = Array.from({ length: 40 }, (_, index) =>
  Array.from({ length: 18 }, (_, word) => 'c' + String(index).padStart(2, '0') + String(word).padStart(2, '0')).join(' '))
const context = paragraphs.join(String.fromCharCode(10).repeat(2)) + String.fromCharCode(10).repeat(2) + 'CTXEND' + String.fromCharCode(10)

// Turn 2: word-sized tokens stream in 100-character provider chunks. The answer
// is taller than the viewport, which is what used to force a full repaint.
const words = Array.from({ length: 400 }, (_, index) => 's' + String(index).padStart(4, '0'))
const answer = words.join(' ')
const chunk = 100
const gap = 120

let turns = 0
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = ''
    req.on('data', data => { body += String(data) })
    req.on('end', async () => {
      const isTitle = body.includes('Create a concise title')
      if (!isTitle) turns += 1
      const turn = turns
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const base = () => ({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
      const send = payload => res.write('data: ' + JSON.stringify(payload) + NL)
      const emit = text => send({ ...base(), choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
      send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      if (isTitle) {
        emit('main screen scroll probe')
      }
      else if (turn === 1) {
        for (let offset = 0; offset < context.length; offset += 4000) {
          emit(context.slice(offset, offset + 4000))
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      else {
        for (let offset = 0; offset < answer.length; offset += chunk) {
          emit(answer.slice(offset, offset + chunk))
          await new Promise(resolve => setTimeout(resolve, gap))
        }
      }
      send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]' + NL)
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root' + String.fromCharCode(10) + '[]' + String.fromCharCode(10))
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + String.fromCharCode(10))
writeFileSync(home + '/profiles/tui/cordis.patch.yml', [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      mock:',
  '        api: openai-completions',
  '        baseURL: http://127.0.0.1:' + String(port) + '/v1',
  '        apiKeyEnv: MOCK_API_KEY',
  '        models:',
  '          - id: mock-model',
  '            name: mock-model',
  '            contextWindow: 128000',
  '            maxTokens: 4096',
  '- id: native-tui',
  '  name: dsh-native-tui',
  '  config:',
  '    agentPreset: standard',
  '    fullscreen: false',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: mock',
  '    model: mock-model',
].join(String.fromCharCode(10)) + String.fromCharCode(10))
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    MOCK_API_KEY: 'dummy',
    COLUMNS: '100',
    LINES: '30',
    FAKE_TTY_COLUMNS: '100',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_NATIVE_TUI_DEBUG: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const strip = text => text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let out = ''
let err = ''
let prompted = false
let secondTurn = false
let exitSent = false
child.stdout.on('data', data => {
  out += String(data)
  const text = strip(out)
  if (!prompted && text.includes('enter send')) {
    prompted = true
    child.stdin.write('ctx' + String.fromCharCode(13))
    return
  }
  if (prompted && !secondTurn && !exitSent && text.includes('CTXEND') && text.includes('● idle')) {
    // Let turn 1 settle and the view return to idle before streaming turn 2.
    secondTurn = true
    setTimeout(() => { try { child.stdin.write('go' + String.fromCharCode(13)) } catch {} }, 1200)
    return
  }
  if (secondTurn && !exitSent && text.includes(words[words.length - 1])) {
    exitSent = true
    setTimeout(() => { try { child.stdin.write(String.fromCharCode(4)) } catch {} }, 1500)
  }
})
child.stderr.on('data', data => { err += String(data) })
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 60000)
child.on('exit', code => {
  clearTimeout(hard)
  server.close()
  const clean = strip(out)
  // Any of these means pi-tui gave up on differential rendering and cleared
  // the screen plus scrollback to repaint the transcript.
  const clears = (out.match(/\x1b\[2J/g) ?? []).length
  const chunkLogs = err.split(String.fromCharCode(10)).filter(line => line.includes('stream chunk: text-delta')).length
  const finalVisible = words.every(word => clean.includes(word))
  const pass = code === 0 && clears === 0 && finalVisible && chunkLogs >= 10
  console.log('EXIT', code, 'turns', turns, 'clears', clears, 'chunkLogs', chunkLogs, 'finalVisible', finalVisible, 'pass', pass)
  if (clears > 0) console.log('FULL REPAINT during a streaming turn: pi-tui cleared the screen and scrollback')
  if (!finalVisible) console.log('streamed answer missing words; last screen tail:', JSON.stringify(clean.slice(-1200)))
  process.exit(pass ? 0 : 1)
})
