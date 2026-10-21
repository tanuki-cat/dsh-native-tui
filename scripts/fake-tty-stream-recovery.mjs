/** Real Host + mock SSE: partial output, a stalled connection, retry, then recovery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-stream-recovery-'))
const profile = join(home, 'profiles', 'tui')
const startMark = 'RECOVERY-THINKING-START'
const endMark = 'RECOVERY-THINKING-END'
const answer = 'STREAM-RECOVERY-DONE'
const reasoning = startMark + '\n' + 'partial reasoning received before the connection stalls. '.repeat(120) + '\n' + endMark
let requests = 0
let dropped = false
let firstResponse
let recoveryResponse
let out = ''
let err = ''
let sent = false
let partialSeen = false
let firstFrameComplete = false
let retrySeen = false
let exitSent = false
const strip = text => text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

function stream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  return (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
}

function respond(res, text) {
  const send = stream(res)
  send('response.created', { response: { id: 'r', status: 'in_progress', output: [] } })
  send('response.output_item.added', { output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
  send('response.output_text.delta', { output_index: 0, delta: text })
  send('response.output_item.done', { output_index: 0, item: {
    id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
  } })
  send('response.completed', { response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 } } })
  res.end('data: [DONE]\n\n')
}

function recover() {
  if (recoveryResponse === undefined || !retrySeen) return
  respond(recoveryResponse, answer)
  recoveryResponse = undefined
}

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model' }] }))
    return
  }
  if (req.url !== '/v1/responses' || req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }
  let body = ''
  req.on('data', data => { body += String(data) })
  req.on('end', () => {
    if (body.includes('Create a concise title')) {
      respond(res, 'Stream recovery')
      return
    }
    requests += 1
    if (requests > 1) {
      recoveryResponse = res
      recover()
      return
    }
    firstResponse = res
    const send = stream(res)
    send('response.created', { response: { id: 'partial', status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { id: 'thought', type: 'reasoning', summary: [] } })
    send('response.output_item.done', { output_index: 0, item: {
      id: 'thought', type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }],
    } })
    // The parent drops this connection only after observing both the full partial output and a working tick.
  })
})

let child
let deadline
try {
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(repo, join(profile, 'node_modules', 'dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-tui', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
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
    agentPreset: standard
    thinkingDisplay: detailed
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)
  child = spawn(process.execPath, [join(repo, 'scripts', 'fake-tty-entry.mjs'), '--profile', 'tui'], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', DSH_NATIVE_TUI_DEBUG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', data => { err += String(data) })
  child.stdout.on('data', data => {
    out += String(data)
    const text = strip(out)
    if (!sent && text.includes('enter send')) {
      sent = true
      child.stdin.write('probe stream recovery\r')
    }
    if (!partialSeen && text.includes(startMark)) {
      partialSeen = true
      firstFrameComplete = text.includes(endMark)
    }
    if (!dropped && text.includes(endMark) && /⟳ working · [1-9]\d*s/.test(text)) {
      dropped = true
      firstResponse.destroy()
    }
    if (/⟳ retry \d+\/\d+ after/.test(text)) {
      retrySeen = true
      recover()
    }
    if (!exitSent && text.includes(answer) && text.lastIndexOf('● idle') > text.lastIndexOf('● working')) {
      exitSent = true
      child.stdin.write('\x04')
    }
  })
  let timedOut = false
  deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 30_000)
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve([code, signal]))
    child.once('error', reject)
  })
  assert.equal(timedOut, false, 'probe timed out')
  assert.equal(signal, null)
  assert.equal(code, 0)
  assert.equal(firstFrameComplete, true, 'partial reasoning must be complete on its first paint')
  assert.equal(dropped, true, 'working must remain visible while the stream stalls')
  assert.equal(retrySeen, true, 'transport retry must be visible')
  assert.ok(requests >= 2, 'Host must retry the dropped stream')
  assert.equal(exitSent, true, 'recovered turn must settle to idle')
  assert.equal(err.includes('reveal text:'), false)
  console.log('PASS', JSON.stringify({ firstFrameComplete, workingDuringStall: dropped, retrySeen, requests, recovered: exitSent }))
}
catch (error) {
  console.error(strip(out).slice(-5_000))
  console.error(err.slice(-3_000))
  throw error
}
finally {
  clearTimeout(deadline)
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('close', resolve))
    child.kill('SIGTERM')
    await exited
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
