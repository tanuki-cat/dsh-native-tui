import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Probes the terminal window title (OSC 0).
 *
 * A terminal tab otherwise shows only the launcher name (`dnt`), so several
 * sessions opened from different checkouts are indistinguishable. The title
 * must name the workspace directory the session edits.
 */
mkdirSync('.tmp', { recursive: true })
const workspace = mkdtempSync('.tmp/window-title-probe-')
const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-window-title-'))
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
      const isTitle = body.includes('Create a concise title')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n')
      const base = () => ({ id: 'chatcmpl-window-title', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
      send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      const text = isTitle ? 'window title E2E' : 'WINDOW TITLE DONE'
      send({ ...base(), choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
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
    agentPreset: ptc
    title: DeepSeek Harness
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }
// Run inside the probe workspace so the session's cwd — not the repository
// the probe was launched from — is what the title must name.
const entry = join(process.cwd(), 'scripts/fake-tty-entry.mjs')
const child = spawn(process.execPath, [entry, '--profile', 'tui'], {
  cwd: workspace,
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
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    try { child.stdin.write('window title probe\r') } catch {}
  }
  else if (phase === 1 && text.includes('WINDOW TITLE DONE')) {
    phase = 2
    seenAt = Date.now()
  }
  else if (phase === 2 && Date.now() - seenAt > 800) {
    phase = 3
    try { child.stdin.write('\x04') } catch {}
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const titles = [...out.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map(match => match[1])
  const workspaceName = workspace.split('/').at(-1)
  const checks = {
    'window title written': titles.length > 0,
    'names the workspace': titles.some(title => title.includes(workspaceName)),
    'keeps the product title': titles.some(title => title.startsWith('DeepSeek Harness')),
    'displayed in the frame': strip(out).includes('WINDOW TITLE DONE'),
  }
  const pass = code === 0 && signal === null && phase === 3 && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'pass', pass)
  console.log(JSON.stringify(checks, null, 2))
  console.log('EMITTED TITLES:', JSON.stringify([...new Set(titles)]))
  console.log('EXPECTED WORKSPACE:', workspaceName)
  if (!pass) {
    console.log('--- STDERR ---')
    console.log(err.slice(-2000))
  }
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
})
