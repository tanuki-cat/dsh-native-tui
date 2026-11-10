import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mapped high level must reach the gateway as xhigh, not its menu label.
const root = mkdtempSync(join(tmpdir(), 'dsh-reasoning-cycle-'))
const requests = []
const checks = { legacy: false, kitty: false, draft: false, wire: false, burst: false, dialog: false, wrap: false }
const server = createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const title = body.includes('Create a concise title')
    if (!title) requests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: 'chatcmpl-cycle', object: 'chat.completion.chunk', created: 1, model: 'mock-model' }
    for (const delta of [{ role: 'assistant' }, { content: 'CYCLE DONE' }]) {
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    }
    res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
})
let child
let closed
let tick
let hard
let timedOut = false
let out = '', err = '', phase = 'start', baseline = 0
const shiftTab = '\x1b[Z'
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const requestFor = marker => requests.find(body => JSON.stringify(body.messages).includes(marker))
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  const workspace = join(root, 'workspace'), home = join(root, 'home')
  mkdirSync(workspace)
  mkdirSync(join(home, 'profiles/tui/node_modules'), { recursive: true })
  mkdirSync(join(home, 'agents'))
  mkdirSync(join(home, 'bundled'))
  writeFileSync(join(workspace, 'package.json'), '{"name":"cycle-probe","private":true}\n')
  writeFileSync(join(home, 'profiles/tui/cordis.yml'), '[]\n')
  writeFileSync(join(home, 'profiles/tui/package.json'), JSON.stringify({
    name: 'cycle-probe-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(process.cwd(), join(home, 'profiles/tui/node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(home, 'profiles/tui/cordis.patch.yml'), [
    '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      mock:',
    '        api: openai-completions', '        baseURL: http://127.0.0.1:' + port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: mock-model', '            name: mock-model', '            contextWindow: 128000',
    '            maxTokens: 4096', '            reasoningEfforts:', '              low: low', '              medium: medium', '              high: xhigh',
    '- id: native-tui', '  name: dsh-native-tui', '  config:', '    agentPreset: ptc',
    '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: mock', '    model: mock-model', '',
  ].join('\n'))
  child = spawn(process.execPath, [join(process.cwd(), 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  closed = once(child, 'close')
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const write = data => { child.stdin.write(data) }
  tick = setInterval(() => {
    const text = strip(out), fresh = text.slice(baseline)
    if (phase === 'start' && text.includes('enter send')) {
      phase = 'low'; write('/reasoning low\r')
    } else if (phase === 'low' && text.includes('Reasoning effort: low')) {
      phase = 'legacy'; write('draft-cycle-proof' + shiftTab)
    } else if (phase === 'legacy' && text.includes('Reasoning effort: medium')) {
      checks.legacy = true
      checks.draft = text.includes('› draft-cycle-proof')
      phase = 'kitty'; write('\x1b[9;2u')
    } else if (phase === 'kitty' && text.includes('Reasoning effort: high')) {
      checks.kitty = true
      phase = 'wire'; write('\r')
    } else if (phase === 'wire' && requestFor('draft-cycle-proof')) {
      checks.wire = requestFor('draft-cycle-proof').reasoning_effort === 'xhigh'
      baseline = text.length; phase = 'burst'; write(shiftTab.repeat(3))
    } else if (phase === 'burst' && /Reasoning effort: low[\s\S]*Reasoning effort: medium[\s\S]*Reasoning effort: high/.test(fresh)) {
      checks.burst = true
      baseline = text.length; phase = 'dialog'; write('/reasoning\r')
    } else if (phase === 'dialog' && fresh.includes('Reasoning effort (current: high)')) {
      baseline = text.length; phase = 'close-dialog'; write(shiftTab + '\x1b')
    } else if (phase === 'close-dialog' && fresh.includes('CYCLE DONE')) {
      phase = 'dialog-wire'; write('after-dialog\r')
    } else if (phase === 'dialog-wire' && requestFor('after-dialog')) {
      checks.dialog = requestFor('after-dialog').reasoning_effort === 'xhigh'
      baseline = text.length; phase = 'wrap'; write(shiftTab)
    } else if (phase === 'wrap' && fresh.includes('Reasoning effort: low')) {
      phase = 'wrap-wire'; write('after-wrap\r')
    } else if (phase === 'wrap-wire' && requestFor('after-wrap')) {
      checks.wrap = requestFor('after-wrap').reasoning_effort === 'low'
      phase = 'done'; write('\x04')
    }
  }, 100)
  hard = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 30000)
  const [code, signal] = await closed
  const pass = !timedOut && code === 0 && signal === null && phase === 'done' && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'timedOut', timedOut)
  console.log('checks', JSON.stringify(checks))
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) console.log(strip(out).slice(-10000), err.slice(-3000))
  process.exitCode = pass ? 0 : 1
} finally {
  clearInterval(tick)
  clearTimeout(hard)
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (closed) await closed.catch(() => {})
  await new Promise(resolve => { server.close(resolve) })
  rmSync(root, { recursive: true, force: true })
}
