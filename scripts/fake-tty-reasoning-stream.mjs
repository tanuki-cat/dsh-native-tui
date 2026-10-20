/**
 * Real-Host check for reasoning that arrives as one completed Responses item.
 *
 * The pi-ai Responses path can receive a gateway's whole reasoning in the
 * terminal `response.output_item.done` event, with no summary/text deltas.
 * The TUI must still reveal that block progressively instead of waiting for the
 * durable assistant message and popping it in whole.
 *
 * One-time setup (the disposable home used by the reasoning probe works):
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-responses-probe-home
 *
 * Run:
 *   node scripts/fake-tty-reasoning-stream.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-responses-probe-home'
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

const settleDelayMs = Number(process.env.PROBE_SETTLE_MS ?? 1200)
const reasoningDelayMs = Number(process.env.PROBE_REASONING_DELAY_MS ?? 300)
const mark = 'RESPONSES-REASONING-START-'
const endMark = '-RESPONSES-REASONING-END'
const reasoning = mark + 'The gateway sent this reasoning as one completed output item. '.repeat(18) + endMark

/** Stream a Responses turn with one completed reasoning item and a short answer. */
function serveResponse(body, res) {
  const isTitle = body.includes('Create a concise title')
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] } })
  if (isTitle) {
    send('response.output_item.added', { output_index: 0, item: { id: 'msg_title', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
    send('response.output_text.delta', { output_index: 0, delta: 'Reasoning stream' })
    send('response.output_item.done', {
      output_index: 0,
      item: { id: 'msg_title', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reasoning stream', annotations: [] }] },
    })
    send('response.completed', { response: { id: 'resp_title', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [] } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  const reasoningItem = { id: 'rs_probe', type: 'reasoning', summary: [] }
  send('response.output_item.added', { output_index: 0, item: reasoningItem })
  setTimeout(() => {
    send('response.output_item.done', {
      output_index: 0,
      item: { ...reasoningItem, summary: [{ type: 'summary_text', text: reasoning }] },
    })
    setTimeout(() => {
      send('response.output_item.added', { output_index: 1, item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
      send('response.output_text.delta', { output_index: 1, delta: 'Probe answer.' })
      send('response.output_item.done', {
        output_index: 1,
        item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Probe answer.', annotations: [] }] },
      })
      send('response.completed', {
        response: {
          id: 'resp_probe',
          status: 'completed',
          usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 },
          output: [],
        },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    }, settleDelayMs)
  }, reasoningDelayMs)
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
    req.on('end', () => { serveResponse(body, res) })
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
`)

const child = spawn(process.execPath, [join(repo, 'scripts', 'fake-tty-entry.mjs'), '--profile', 'tui'], {
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
let prefixAt
let endAt
let finalAt
let waitingSeen = false
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (text.includes('waiting for response')) waitingSeen = true
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'prompt'
    try { child.stdin.write('probe reasoning stream\r') } catch {}
  }
  else if (phase === 'prompt' || phase === 'streaming' || phase === 'settled') {
    if (prefixAt === undefined && text.includes(mark)) {
      prefixAt = Date.now() - started
      phase = 'streaming'
    }
    if (endAt === undefined && text.includes(endMark)) endAt = Date.now() - started
    if (finalAt === undefined && text.includes('Probe answer.')) {
      finalAt = Date.now() - started
      phase = 'settled'
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
    }
  }
}, 50)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 20000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const streaming = prefixAt !== undefined && endAt !== undefined && endAt - prefixAt >= 100
  const completed = finalAt !== undefined
  // The answer text is held until the reveal completes, so it must never appear
  // before the reasoning end marker.
  const answerOrdered = endAt !== undefined && finalAt !== undefined && finalAt >= endAt
  const waitingCovered = reasoningDelayMs < 1100 || waitingSeen
  const pass = streaming && completed && answerOrdered && waitingCovered
    && text.includes(mark) && text.includes(endMark)
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('settleDelayMs', settleDelayMs, 'reasoningDelayMs', reasoningDelayMs, 'waitingSeen', waitingSeen, 'answerOrdered', answerOrdered)
  console.log('prefixAt', prefixAt, 'endAt', endAt, 'finalAt', finalAt)
  console.log('reasoning rendered', text.includes(mark), text.includes(endMark))
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-8000))
    console.log('--- stderr ---')
    console.log(err.slice(-3000))
  }
  server.close()
  process.exit(pass ? 0 : 1)
})
