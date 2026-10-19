/**
 * Real-Host check that a tool card does not overtake a still-revealing thinking block.
 *
 * The mock Responses server sends one completed reasoning item, then a run_code
 * function call. The TUI must finish revealing the reasoning before rendering
 * the tool card, then run the tool and receive the final answer.
 *
 * Setup:
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-reasoning-tool-order-home
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-reasoning-tool-order-home node scripts/fake-tty-reasoning-tool-order.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-reasoning-tool-order-home'
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

const startMark = 'TOOL-ORDER-REASONING-START-'
const endMark = '-TOOL-ORDER-REASONING-END'
const reasoning = startMark + 'The model is thinking about the next tool call. '.repeat(24) + endMark
const toolArgs = JSON.stringify({ description: 'Tool order probe', code: '1 + 1' })

function sendMessage(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'resp_msg', object: 'response', status: 'in_progress', output: [] } })
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

function sendToolTurn(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'resp_tool', object: 'response', status: 'in_progress', output: [] } })
  const reasoningItem = { id: 'rs_1', type: 'reasoning', summary: [] }
  send('response.output_item.added', { output_index: 0, item: reasoningItem })
  setTimeout(() => {
    send('response.output_item.done', {
      output_index: 0,
      item: { ...reasoningItem, summary: [{ type: 'summary_text', text: reasoning }] },
    })
    send('response.output_item.added', {
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run_code', arguments: '' },
    })
    send('response.function_call_arguments.delta', { output_index: 1, delta: toolArgs })
    send('response.output_item.done', {
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run_code', arguments: toolArgs },
    })
    send('response.completed', {
      response: { id: 'resp_tool', status: 'completed', usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 }, output: [] },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  }, 100)
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
      if (body.includes('Create a concise title')) {
        sendMessage(res, 'Tool order')
        return
      }
      if (body.includes('call_1') || body.includes('function_call_output')) {
        sendMessage(res, 'TOOL ORDER DONE')
        return
      }
      sendToolTurn(res)
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
let prefixAt
let endAt
let toolAt
let finalAt
let approved = false
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (!approved && text.includes('Approval required')) {
    approved = true
    try { child.stdin.write('\r') } catch {}
  }
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'prompt'
    try { child.stdin.write('probe tool order\r') } catch {}
  }
  else if (phase !== 'done') {
    if (prefixAt === undefined && text.includes(startMark)) prefixAt = Date.now() - started
    if (endAt === undefined && text.includes(endMark)) endAt = Date.now() - started
    if (toolAt === undefined && text.includes('⚙ run_code')) toolAt = Date.now() - started
    if (finalAt === undefined && text.includes('TOOL ORDER DONE')) {
      finalAt = Date.now() - started
      phase = 'done'
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
    }
  }
}, 50)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 30000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const streaming = prefixAt !== undefined && endAt !== undefined && endAt - prefixAt >= 100
  const ordered = endAt !== undefined && toolAt !== undefined && toolAt >= endAt
  const completed = finalAt !== undefined
  const pass = streaming && ordered && completed
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('prefixAt', prefixAt, 'endAt', endAt, 'toolAt', toolAt, 'finalAt', finalAt)
  console.log('streaming', streaming, 'ordered', ordered, 'completed', completed)
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-12000))
    console.log('--- stderr tail ---')
    console.log(err.slice(-4000))
  }
  server.close()
  process.exit(pass ? 0 : 1)
})
