/**
 * Real-Host check that the wait row names the tool call being generated.
 *
 * The mock Responses server holds a function call for a while: it announces the
 * item, waits, then streams the arguments. A bare tool block-start must not
 * clear the wait row, so the row has to switch from the generic request text to
 * `generating run_code call` while the arguments are still streaming.
 *
 * Setup:
 *   pnpm build
 *   cp -a /tmp/dsh-native-tui-reasoning-home /tmp/dsh-native-tui-wait-tool-phase-home
 *
 * Run:
 *   DSH_HOME=/tmp/dsh-native-tui-wait-tool-phase-home node scripts/fake-tty-wait-tool-phase.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-wait-tool-phase-home'
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

const toolArgs = JSON.stringify({ description: 'Wait phase probe', code: '1 + 1' })
// Long enough to cross the 1s flash window and be seen as a tool phase.
const holdMs = 2_500

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
  // The item first, then the arguments over several frames: a real provider
  // streams the call's JSON, which is the window the wait row has to name it.
  send('response.output_item.added', {
    output_index: 0,
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run_code', arguments: '' },
  })
  const pieces = 5
  const piece = Math.ceil(toolArgs.length / pieces)
  let sent = 0
  const streamArgs = () => {
    if (sent >= toolArgs.length) {
      send('response.output_item.done', {
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run_code', arguments: toolArgs },
      })
      send('response.completed', {
        response: { id: 'resp_tool', status: 'completed', usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 }, output: [] },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    send('response.function_call_arguments.delta', { output_index: 0, delta: toolArgs.slice(sent, sent + piece) })
    sent += piece
    setTimeout(streamArgs, holdMs / pieces)
  }
  setTimeout(streamArgs, holdMs)
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
        sendMessage(res, 'Wait phase')
        return
      }
      if (body.includes('call_1') || body.includes('function_call_output')) {
        sendMessage(res, 'WAIT PHASE DONE')
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
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: ptc
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
let requestAt
let toolPhaseAt
let approved = false
let finalAt
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'prompt'
    try { child.stdin.write('probe wait phase\r') } catch {}
  }
  else if (phase !== 'done') {
    if (requestAt === undefined && text.includes('waiting for response')) requestAt = Date.now() - started
    if (toolPhaseAt === undefined && text.includes('generating run_code call')) toolPhaseAt = Date.now() - started
    if (!approved && text.includes('Approval required')) {
      approved = true
      try { child.stdin.write('\r') } catch {}
    }
    if (finalAt === undefined && text.includes('WAIT PHASE DONE')) {
      finalAt = Date.now() - started
      phase = 'done'
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
    }
  }
}, 50)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  // Both texts must show, in order: the request first, then the tool phase.
  const sawRequest = requestAt !== undefined
  const sawToolPhase = toolPhaseAt !== undefined
  const ordered = sawRequest && sawToolPhase && toolPhaseAt >= requestAt
  // The row is repainted until the call settles; the accumulated stream keeps
  // those frames, so "gone" means its last paint precedes the tool card.
  const rowEnd = text.lastIndexOf('generating run_code call ·')
  const cardStart = text.indexOf('⚙ run_code')
  const clearedAfter = rowEnd !== -1 && cardStart !== -1 && rowEnd < cardStart
  const completed = finalAt !== undefined
  const pass = ordered && clearedAfter && completed
  console.log('EXIT', code, signal, 'phase', phase)
  console.log('requestAt', requestAt, 'toolPhaseAt', toolPhaseAt, 'finalAt', finalAt)
  console.log('sawRequest', sawRequest, 'sawToolPhase', sawToolPhase, 'ordered', ordered, 'clearedAfter', clearedAfter, 'completed', completed)
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
