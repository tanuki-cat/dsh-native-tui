
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const NL = String.fromCharCode(10).repeat(2)
const home = '/tmp/dsh-native-tui-tool-late-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })

// Turn 1 fills the transcript far past the viewport.
const paragraphs = Array.from({ length: 40 }, (_, index) =>
  Array.from({ length: 18 }, (_, word) => 'c' + String(index).padStart(2, '0') + String(word).padStart(2, '0')).join(' '))
const context = paragraphs.join(NL) + NL + 'CTXEND' + NL

// Turn 2 runs a tool call, then streams a long answer so the pending card head
// scrolls above the viewport BEFORE the result settles it.
const toolArgs = JSON.stringify({
  command: 'echo TOOL_LATE_OK',
  note: Array.from({ length: 40 }, (_, i) => 'arg' + String(i).padStart(3, '0') + ' ' + 'y'.repeat(70)).join('\n'),
})
const answerWords = Array.from({ length: 200 }, (_, index) => 'a' + String(index).padStart(3, '0'))
const answer = answerWords.join(' ')

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
        emit('tool late probe')
      }
      else if (turn === 1) {
        for (let offset = 0; offset < context.length; offset += 4000) {
          emit(context.slice(offset, offset + 4000))
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      else if (turn === 2) {
        // Tool call first: the pending card paints at the bottom.
        send({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: 'call-late',
          type: 'function',
          function: { name: 'bash', arguments: toolArgs },
        }] }, finish_reason: null }] })
        send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      }
      else if (turn === 3) {
        // Long answer pushes the settled card's head above the viewport.
        for (let offset = 0; offset < answer.length; offset += 100) {
          emit(answer.slice(offset, offset + 100))
          await new Promise(resolve => setTimeout(resolve, 40))
        }
      }
      else {
        emit('TOOL LATE DONE')
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

writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root' + NL + '[]' + NL)
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + NL)
writeFileSync(home + '/profiles/tui/cordis.patch.yml', [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      mock:',
  '        api: openai-completions',
  '        baseURL: http://127.0.0.1:' + port + '/v1',
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
].join(NL) + NL)
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '100', LINES: '30', FAKE_TTY_COLUMNS: '100', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const strip = text => text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let out = ''
let phase = 0
child.stdout.on('data', data => {
  out += String(data)
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) { phase = 1; child.stdin.write('ctx' + String.fromCharCode(13)); return }
  if (phase === 1 && text.includes('CTXEND') && text.includes('● idle')) {
    phase = 2
    setTimeout(() => { try { child.stdin.write('tool' + String.fromCharCode(13)) } catch {} }, 1200)
    return
  }
  if (phase === 2 && text.includes('⚙ bash')) {
    phase = 3
    setTimeout(() => { try { child.stdin.write('answer' + String.fromCharCode(13)) } catch {} }, 1500)
    return
  }
  if (phase === 3 && text.includes('TOOL LATE DONE') && text.includes('● idle')) {
    phase = 4
    setTimeout(() => { try { child.stdin.write(String.fromCharCode(4)) } catch {} }, 1200)
  }
})
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 120000)
child.on('exit', code => {
  clearTimeout(hard)
  server.close()
  const clean = strip(out)
  const clears = (out.match(/\x1b\[2J/g) ?? []).length
  const cardSeen = clean.includes('TOOL_LATE_OK') || clean.includes('⚙ bash')
  const answerSeen = clean.includes('TOOL LATE DONE')
  const pass = code === 0 && clears === 0 && cardSeen && answerSeen
  console.log('EXIT', code, 'phase', phase, 'clears', clears, 'cardSeen', cardSeen, 'answerSeen', answerSeen, 'pass', pass)
  if (!pass) console.log(JSON.stringify(clean.slice(-1000)))
  process.exit(pass ? 0 : 1)
})
