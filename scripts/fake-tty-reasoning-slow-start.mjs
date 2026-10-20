/**
 * Real-Host check for a long API wait followed by one large reasoning block.
 *
 * Verifies the thinking placeholder, no whole-block pop-in, the wait row, and
 * that the thinking text is revealed progressively. The answer may appear
 * while the reveal is still running: it is real streamed content and the
 * transcript no longer hides it behind the animation.
 *
 * Setup:
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-slow-start-home
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-slow-start-home node scripts/fake-tty-reasoning-slow-start.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-slow-start-home'
if (!home.startsWith('/tmp/dsh-native-tui-')) {
  console.error('Refusing to rewrite a profile outside a disposable /tmp/dsh-native-tui-* home: ' + home)
  process.exit(2)
}
const profile = join(home, 'profiles', 'tui')
if (!existsSync(profile)) {
  if (!existsSync('/tmp/dsh-native-tui-reasoning-home')) {
    console.error('Install a TUI profile at ' + home + ' first (or copy the reasoning probe home).')
    process.exit(2)
  }
  cpSync('/tmp/dsh-native-tui-reasoning-home', home, { recursive: true })
}

const startMark = 'SLOW-REASONING-START-'
const middleMark = '-SLOW-REASONING-MIDDLE-'
// The middle marker is inside the 3000-grapheme preview, so it proves the
// block is being revealed rather than painted in one frame.
const reasoning = startMark + 'x'.repeat(200) + middleMark + 'x'.repeat(5_800)

function sendMessage(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'resp_msg', status: 'in_progress', output: [] } })
  send('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
  send('response.output_text.delta', { output_index: 0, delta: text })
  send('response.output_item.done', {
    output_index: 0,
    item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  })
  send('response.completed', {
    response: { id: 'resp_msg', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [] },
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendSlow(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'resp_slow', status: 'in_progress', output: [] } })
  const reasoningItem = { id: 'rs_slow', type: 'reasoning', summary: [] }
  send('response.output_item.added', { output_index: 0, item: reasoningItem })
  setTimeout(() => {
    send('response.output_item.done', {
      output_index: 0,
      item: { ...reasoningItem, summary: [{ type: 'summary_text', text: reasoning }] },
    })
    send('response.output_item.added', { output_index: 1, item: { id: 'msg_slow', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
    send('response.output_text.delta', { output_index: 1, delta: 'SLOW ANSWER DONE' })
    send('response.output_item.done', {
      output_index: 1,
      item: { id: 'msg_slow', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SLOW ANSWER DONE', annotations: [] }] },
    })
    send('response.completed', {
      response: { id: 'resp_slow', status: 'completed', usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 }, output: [] },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  }, 2_000)
}

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model' }] }))
    return
  }
  if (req.url === '/v1/responses' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      if (body.includes('Create a concise title')) sendMessage(res, 'Slow start')
      else sendSlow(res)
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

writeFileSync(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: openai-responses
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
            reasoningEfforts:
              low: low
              high: high
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: ptc
    thinkingDisplay: detailed
`)

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: repo,
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let phase = 'editor'
let placeholderAt
let waitingAt
let startAt
let middleAt
let answerAt
let firstChunkHadMiddle = false
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (placeholderAt === undefined && text.includes('thinking …')) placeholderAt = Date.now() - started
  if (waitingAt === undefined && text.includes('waiting for response')) waitingAt = Date.now() - started
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'prompt'
    try { child.stdin.write('slow start probe\r') } catch {}
  }
  else {
    if (startAt === undefined && text.includes(startMark)) {
      startAt = Date.now() - started
      // The frame that first shows the start marker must not already show the
      // marker 200 characters in, or the block was painted in one piece.
      firstChunkHadMiddle = text.includes(middleMark)
    }
    if (middleAt === undefined && text.includes(middleMark)) middleAt = Date.now() - started
    if (answerAt === undefined && text.includes('SLOW ANSWER DONE')) answerAt = Date.now() - started
    if (phase !== 'done' && middleAt !== undefined && answerAt !== undefined) {
      phase = 'done'
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
    }
  }
}, 25)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  // Progressive reveal: the start marker appears before the marker 200
  // characters further in, and the first frame that shows the start marker is
  // not already a whole block.
  const streamed = startAt !== undefined && middleAt !== undefined && middleAt >= startAt
  const answered = answerAt !== undefined
  const placeholderOrdered = placeholderAt !== undefined
    && (startAt === undefined || placeholderAt <= startAt)
  const waitingOrdered = waitingAt !== undefined
    && (startAt === undefined || waitingAt <= startAt)
  const pass = placeholderOrdered && waitingOrdered
    && startAt !== undefined && !firstChunkHadMiddle && streamed && answered
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('placeholderAt', placeholderAt, 'waitingAt', waitingAt)
  console.log('startAt', startAt, 'middleAt', middleAt, 'answerAt', answerAt, 'firstChunkHadMiddle', firstChunkHadMiddle)
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-12000))
    console.log('--- stderr tail ---')
    console.log(err.slice(-3000))
  }
  server.close()
  process.exit(pass ? 0 : 1)
})
