import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Probes the compact run_code/bash cards on the non-PTC presets.
 *
 * The PTC call list only exists where `run_code` dispatches (`ptc`). These
 * presets run tools natively, so their compact cards must keep the previous
 * description/result shape and never grow a `├ mcp …`-style call list.
 */
mkdirSync('.tmp', { recursive: true })

/** Presets under test and the tool sequence each one exposes. */
const CASES = [
  { preset: 'standard', steps: ['read', 'bash'] },
  { preset: 'minimal', steps: ['bash'] },
]

async function runCase({ preset, steps }) {
  const workspace = mkdtempSync('.tmp/' + preset + '-compact-')
  const file = workspace + '/a.txt'
  writeFileSync(file, 'alpha\n')
  const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-' + preset + '-compact-'))
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
        const done = messages.filter(message => message.role === 'tool').length
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n')
        const base = () => ({ id: 'chatcmpl-' + preset, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
        send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
        const step = steps[done]
        if (isTitle) {
          send({ ...base(), choices: [{ index: 0, delta: { content: preset + ' compact E2E' }, finish_reason: null }] })
        }
        else if (step === undefined) {
          send({ ...base(), choices: [{ index: 0, delta: { content: preset.toUpperCase() + ' COMPACT DONE' }, finish_reason: null }] })
        }
        else {
          const args = step === 'read'
            ? { file_path: file }
            : { description: 'List files', command: 'ls -la ' + workspace }
          send({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{
            index: 0,
            id: 'call-' + step,
            type: 'function',
            function: { name: step, arguments: JSON.stringify(args) },
          }] }, finish_reason: null }] })
          send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
        res.end()
      })
      return
    }
    res.writeHead(404); res.end('not found')
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
    agentPreset: ${preset}
    runCodeDisplay: compact
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
  let out = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', () => {})
  const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const marker = preset.toUpperCase() + ' COMPACT DONE'
  let phase = 0
  let seenAt = 0
  const tick = setInterval(() => {
    const text = strip(out)
    if (phase === 0 && text.includes('enter send')) {
      phase = 1
      try { child.stdin.write('run the ' + preset + ' compact probe\r') } catch {}
    }
    else if (phase === 1 && text.includes(marker)) {
      phase = 2
      seenAt = Date.now()
    }
    else if (phase === 2 && Date.now() - seenAt > 1200) {
      phase = 3
      try { child.stdin.write('\x04') } catch {}
    }
  }, 200)
  const result = await new Promise(resolve => {
    const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
    child.on('exit', (code, signal) => {
      clearInterval(tick); clearTimeout(hard); server.close()
      resolve({ code, signal, phase, clean: strip(out) })
    })
  })
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  return { ...result, file }
}

let failed = false
for (const testCase of CASES) {
  const { code, signal, phase, clean, file } = await runCase(testCase)
  const checks = {
    'bash compact card': clean.includes('⚙ bash'),
    'bash description in card': clean.includes('List files'),
    'no PTC call rows': !/├ read |├ mcp |├ bash ls/u.test(clean),
    'no program source': !clean.includes('await tools.'),
    'assistant reply': clean.includes(testCase.preset.toUpperCase() + ' COMPACT DONE'),
  }
  if (testCase.steps.includes('read')) {
    // `read` is not a code-execution tool, so compact leaves its generic card
    // (head + args + status) alone.
    checks['read keeps generic card'] = clean.includes('⚙ read') && clean.includes('├ args')
    checks['read path shown'] = clean.includes(file)
  }
  const pass = code === 0 && signal === null && phase === 3 && Object.values(checks).every(Boolean)
  if (!pass) failed = true
  console.log('=== ' + testCase.preset + ' ===')
  console.log('EXIT', code, signal, 'phase', phase, 'pass', pass)
  console.log(JSON.stringify(checks, null, 2))
  const cards = clean.split('\n').filter(line => /⚙|├|└/u.test(line)).map(line => line.trim())
  console.log('--- CARDS ---')
  console.log([...new Set(cards)].join('\n'))
}
process.exit(failed ? 1 : 0)
