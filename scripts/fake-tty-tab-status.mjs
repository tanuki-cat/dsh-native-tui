import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Probes the terminal tab status (OSC 7501, Program Status Protocol).
 *
 * Answer the capability query, then drive a turn and two Host question
 * requests: one permission confirmation and one ordinary question.
 */
mkdirSync('.tmp', { recursive: true })
const workspace = mkdtempSync('.tmp/tab-status-probe-')
const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-tab-status-'))
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
      const base = () => ({ id: 'chatcmpl-tab-status', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' })
      send({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      const text = isTitle ? 'tab status E2E' : 'TAB STATUS DONE'
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
const profile = join(home, 'profiles/tui')
const fixture = join(profile, 'node_modules/tab-status-probe')
mkdirSync(fixture, { recursive: true })
writeFileSync(join(fixture, 'package.json'), '{"name":"tab-status-probe","type":"module","exports":"./index.js"}\n')
writeFileSync(join(fixture, 'index.js'), [
  'export const inject = ["commands", "userQuestions"]',
  'export function apply(ctx) {',
  '  ctx.commands.register({',
  '    name: "tab-status-probe",',
  '    description: "Exercise terminal permission and question states.",',
  '    async handler({ agent, signal }) {',
  '      const ask = question => ctx.userQuestions.ask({ agent, signal, questions: [question] })',
  '      const approval = await ask({ id: "approval", question: "TAB STATUS APPROVAL", detail: "Fixture permission",',
  '        options: [{ label: "Allow" }, { label: "Deny" }], intent: { kind: "approval", approve: "Allow", reject: "Deny" } })',
  '      if (approval.answers[0]?.selected[0] !== "Deny") return { kind: "error", text: "Expected denial" }',
  '      const question = await ask({ id: "question", question: "TAB STATUS QUESTION", options: [{ label: "Continue" }] })',
  '      if (question.answers[0]?.selected[0] !== "Continue") return { kind: "error", text: "Expected Continue" }',
  '      return { kind: "success", text: "TAB STATUS DIALOGS DONE" }',
  '    },',
  '  })',
  '}',
].join('\n'))
writeFileSync(join(profile, 'cordis.yml'), '# dsh profile root\n[]\n')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd(), 'tab-status-probe': 'file:./node_modules/tab-status-probe' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:
    - id: tab-status-probe
      name: tab-status-probe
- id: llm-pi-ai
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
symlinkSync(process.cwd(), join(profile, 'node_modules/dsh-native-tui'), 'dir')
const entry = join(process.cwd(), 'scripts/fake-tty-entry.mjs')
const env = {
  ...process.env,
  DSH_HOME: home,
  MOCK_API_KEY: 'dummy',
  FAKE_TTY_COLUMNS: '130',
  FAKE_TTY_ROWS: '50',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  DSH_NATIVE_TUI_DEBUG: '1',
}
delete env.PI_PROGRAM_STATUS
const child = spawn(process.execPath, [entry, '--profile', 'tui'], {
  cwd: workspace,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const query = '\x1b]7501;?\x1b\\'
let phase = 'negotiation'
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'negotiation' && out.includes(query)) {
    phase = 'editor'
    child.stdin.write(query + '\x1b[?1;2c')
  }
  else if (phase === 'editor' && text.includes('enter send') && out.includes('\x1b]7501;state=idle:')) {
    phase = 'turn'
    child.stdin.write('tab status probe\r')
  }
  else if (phase === 'turn' && text.includes('TAB STATUS DONE') && out.includes('\x1b]7501;state=done:')) {
    phase = 'approval'
    child.stdin.write('/tab-status-probe\r')
  }
  else if (phase === 'approval' && text.includes('TAB STATUS APPROVAL')) {
    phase = 'question'
    child.stdin.write('\r')
  }
  else if (phase === 'question' && text.includes('TAB STATUS QUESTION')) {
    phase = 'settled'
    child.stdin.write('\r')
  }
  else if (phase === 'settled' && text.includes('TAB STATUS DIALOGS DONE')) {
    phase = 'exit'
    child.stdin.write('\x04')
  }
}, 200)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('close', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  const records = [...out.matchAll(/\x1b\]7501;(state=[^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(match => match[1])
  const titles = [...out.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map(match => match[1])
  const states = records.map(record => /(?:^|:)state=([^:]+)/.exec(record)?.[1] ?? '')
  const apps = records.map(record => /(?:^|:)app=([^:]+)/.exec(record)?.[1] ?? '')
  const activities = records.map((record, index) => {
    const kind = /(?:^|:)kind=([^:]+)/.exec(record)?.[1]
    return kind === undefined ? states[index] : states[index] + ':' + kind
  })
  const expected = ['idle', 'working', 'done', 'blocked:permission', 'done', 'blocked:question', 'done', 'clear']
  const waitingMessages = records.filter((_, index) => states[index] === 'blocked').map(record => {
    const encoded = /(?:^|:)msg=([^:]+)/.exec(record)?.[1] ?? ''
    return Buffer.from(encoded, 'base64').toString('utf8')
  })
  const checks = {
    'negotiates program status': out.includes(query),
    'reports exactly the expected states in order': JSON.stringify(activities) === JSON.stringify(expected),
    'reports waiting:permission and waiting:question messages': JSON.stringify(waitingMessages) === JSON.stringify(['waiting:permission', 'waiting:question']),
    // `clear` removes the record, so it carries no app; every real state does.
    'names the program on every record': records.length > 0 && apps.every((app, index) => states[index] === 'clear' || app === 'dsh'),
    'keeps the workspace title': titles.some(title => title.includes(workspace.split('/').at(-1))),
  }
  const pass = code === 0 && signal === null && phase === 'exit' && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'pass', pass)
  console.log(JSON.stringify(checks, null, 2))
  console.log('EMITTED RECORDS:', JSON.stringify(records))
  console.log('EMITTED TITLES:', JSON.stringify([...new Set(titles)]))
  if (!pass) {
    console.log('--- STDERR ---')
    console.log(err.slice(-2000))
  }
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
})
