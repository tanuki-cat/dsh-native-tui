/**
 * Real-Host approval end-to-end check for the terminal front door.
 *
 * A mock OpenAI-compatible model streams one \`bash\` tool call. The committed
 * approval-gate probe turns the real \`tools/pre-execute\` gate into an \`ask\`
 * decision, so the call travels through the real ApprovalService and the
 * terminal's \`approval/request\` overlay. Four modes drive the overlay and
 * assert the outcome the model finally saw:
 *
 *   allow      -> the bash body runs and its stdout reaches the model
 *   reject     -> the call is denied with the user-rejected reason
 *   cancel-row -> the explicit Cancel row denies the call as cancelled
 *   cancel-esc -> Esc denies the call as cancelled
 *
 * One-time setup (installs this repo's current build into a scratch home):
 *   pnpm pack --pack-destination .tmp
 *   DSH_HOME=/tmp/dsh-native-tui-approval-home dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz
 *
 * Run with:
 *   DSH_HOME=/tmp/dsh-native-tui-approval-home node scripts/fake-tty-approval.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-approval-home'
const profile = join(home, 'profiles', 'tui')

if (!existsSync(join(profile, 'node_modules', 'dsh-native-tui'))) {
  console.error('Install this build into ' + home + ' first:')
  console.error('  pnpm pack --pack-destination .tmp')
  console.error('  DSH_HOME=' + home + ' dsh plugin --profile tui add .tmp/dsh-native-tui-0.2.1-rc.2.tgz')
  process.exit(2)
}

// The profile resolves plugins from its own node_modules, so stage the probe there.
cpSync(join(repo, 'scripts', 'approval-gate-probe'), join(profile, 'node_modules', 'approval-gate-probe'), { recursive: true })
const profilePackage = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
profilePackage.dependencies = { ...profilePackage.dependencies, 'approval-gate-probe': 'file:./node_modules/approval-gate-probe' }
writeFileSync(join(profile, 'package.json'), JSON.stringify(profilePackage, null, 2) + '\n')

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
      const toolMessage = [...messages].reverse().find(message => message.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n')
      const base = () => ({ id: 'chatcmpl-approval', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
      send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      if (isTitle) {
        send({ ...base(), choices: [{ index: 0, delta: { content: 'Approval E2E' }, finish_reason: null }] })
      }
      else if (toolMessage === undefined) {
        send({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: 'call-approval-1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ description: 'Approval probe', command: 'echo approval-probe-ok' }) },
        }] }, finish_reason: null }] })
        send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      }
      else {
        const content = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content)
        send({ ...base(), choices: [{ index: 0, delta: { content: 'FINAL ' + content }, finish_reason: null }] })
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

writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
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
    - id: approval-gate-probe
      name: approval-gate-probe
    - id: native-tui
      name: dsh-native-tui
      config:
        agentPreset: standard
`)

const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

async function runMode(mode) {
  const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += String(data) })
  child.stderr.on('data', data => { err += String(data) })
  let phase = 'editor'
  let overlaySeen = false
  const tick = setInterval(() => {
    const text = strip(out)
    if (phase === 'editor' && text.includes('enter send')) {
      phase = 'model'
      try { child.stdin.write('/model mock/mock-model\r') } catch {}
    }
    else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
      phase = 'prompt'
      try { child.stdin.write('run the approval probe\r') } catch {}
    }
    else if ((phase === 'prompt' || phase === 'waited') && text.includes('Approval required')) {
      if (!overlaySeen) {
        overlaySeen = true
        phase = 'answered'
        setTimeout(() => {
          try {
            if (mode === 'allow') child.stdin.write('\r')
            else if (mode === 'reject') {
              child.stdin.write('\x1b[B')
              setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 250)
            }
            else if (mode === 'cancel-row') {
              child.stdin.write('\x1b[B')
              setTimeout(() => { try { child.stdin.write('\x1b[B') } catch {} }, 250)
              setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 500)
            }
            else child.stdin.write('\x1b')
          } catch {}
        }, 400)
      }
    }
    else if (phase === 'answered' && text.includes('FINAL')) {
      phase = 'done'
      setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 600)
    }
  }, 200)
  const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25000)
  await new Promise(resolve => child.on('exit', () => resolve()))
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  // The mock echoes the tool result it received as the final assistant text, so
  // only that line proves what the tool call actually settled with.
  const finalAt = text.lastIndexOf('FINAL ')
  const final = finalAt < 0 ? '' : text.slice(finalAt + 'FINAL '.length).split('\n')[0]
  return { text, final, err, overlaySeen }
}

const cases = [
  { mode: 'allow', present: ['approval-probe-ok'] },
  { mode: 'reject', present: ['the user rejected tool'] },
  { mode: 'cancel-row', present: ['was cancelled'] },
  { mode: 'cancel-esc', present: ['was cancelled'] },
]

let failed = 0
for (const testCase of cases) {
  const result = await runMode(testCase.mode)
  const missing = testCase.present.filter(token => !result.final.includes(token))
  const ok = result.overlaySeen && missing.length === 0
  if (!ok) failed += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + testCase.mode
    + ' overlay=' + String(result.overlaySeen)
    + ' final=' + JSON.stringify(result.final.slice(0, 120))
    + (missing.length === 0 ? '' : ' missing=' + JSON.stringify(missing)))
  if (!ok) {
    console.log('--- ' + testCase.mode + ' stdout tail ---')
    console.log(result.text.slice(-4000))
    console.log('--- ' + testCase.mode + ' stderr tail ---')
    console.log(result.err.slice(-2000))
  }
}

server.close()
console.log(failed === 0 ? 'OK approval waterfall verified' : 'FAILED ' + failed + ' mode(s)')
process.exit(failed === 0 ? 0 : 1)
