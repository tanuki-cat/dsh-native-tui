/** Real Host lifecycle with an owner-scoped terminal-fence fixture; no physical PTY is required. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const repo = process.cwd(), root = mkdtempSync(join(tmpdir(), 'dsh-permission-restart-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), profile = join(home, 'profiles/tui')
const counts = new Map(), results = new Map(), checks = {}
let child, closed, out = '', err = '', retainedHistory = false
const pending = new Set()
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
function waitFor(start, predicate, label) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); pending.delete(check); error ? reject(error) : resolve(strip(out.slice(start))) }
    const check = () => {
      if (predicate(strip(out.slice(start)))) finish()
      else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(label + ': child exited'))
    }
    const timer = setTimeout(() => finish(new Error(label + ': timeout')), 20000)
    pending.add(check); check()
  })
}
async function input(text, marker) {
  const start = out.length
  child.stdin.write(text)
  return waitFor(start, output => output.includes(marker), JSON.stringify(text) + ' → ' + marker)
}
const line = (text, marker) => input(text + '\r', marker)
async function turn(stage) {
  const start = out.length, marker = 'DONE ' + stage
  child.stdin.write('PERMISSIONPROBE:' + stage + '\r')
  return waitFor(start, text => text.includes(marker) && text.lastIndexOf('enter send') > text.lastIndexOf(marker), marker)
}
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const messages = JSON.parse(raw).messages ?? []
    const stage = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).reverse()
      .map(text => /PERMISSIONPROBE:(first|second|third)/.exec(text)?.[1]).find(Boolean)
    const title = raw.includes('Create a concise title')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'restart-probe', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant' })
    if (!title && stage && !counts.has(stage)) {
      counts.set(stage, 1)
      send({ tool_calls: [{ index: 0, id: 'fixture-' + stage, type: 'function', function: { name: 'fixture_shell', arguments: '{}' } }] })
      send({}, 'tool_calls')
    } else {
      if (!title && stage) {
        results.set(stage, JSON.stringify([...messages].reverse().find(message => message.role === 'tool')?.content))
        if (stage === 'third') retainedHistory = raw.includes('PERMISSIONPROBE:first') && raw.includes('PERMISSIONPROBE:second')
      }
      send({ content: stage ? 'DONE ' + stage : 'Restart probe' }); send({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  mkdirSync(workspace); mkdirSync(join(profile, 'node_modules/fixture-shell'), { recursive: true })
  mkdirSync(join(home, 'agents')); mkdirSync(join(home, 'bundled'))
  writeFileSync(join(workspace, 'package.json'), '{"private":true}')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'restart-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo, 'fixture-shell': 'file:./node_modules/fixture-shell' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'node_modules/fixture-shell/package.json'), '{"name":"fixture-shell","type":"module","exports":"./index.js"}')
  writeFileSync(join(profile, 'node_modules/fixture-shell/index.js'), [
    'export const inject = ["tools", "sessionProjections", "sandboxPolicy"]',
    'export function apply(ctx) { const owners = new WeakMap(); let generation = 0;',
    'ctx.tools.register({ name: "fixture_shell", description: "Install the fixture owner terminal fence.", parameters: { type: "object", properties: {}, additionalProperties: false },',
    'output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },',
    'execute: async (_args, exec) => { const owner = exec.agent; if (!owners.has(owner)) { owners.set(owner, ++generation);',
    'owner.ctx.on("internal/dispatch", (_mode, name, args) => { if (name !== "session/event") return; const [session, event] = args;',
    'if (session !== owner.session || event.type !== "sandbox/mode") return; const current = ctx.sessionProjections.stateOf(session, "sandboxMode") ?? ctx.sandboxPolicy.defaultMode;',
    'if (event.data.mode !== current) throw new Error("cannot change sandbox mode from \\\"" + current + "\\\" to \\\"" + event.data.mode + "\\\" while persistent terminal sessions are open or being created; wait for creation to settle and close them first");',
    '}, { global: true }); } return "SHELL_GENERATION_" + owners.get(owner); } }); }',
  ].join('\n'))
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- insert:', '    - id: fixture-shell', '      name: fixture-shell',
    '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      mock:', '        api: openai-completions',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY', '        models:',
    '          - id: mock', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  name: dsh-native-tui', '  config:', '    agentPreset: minimal',
    '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: mock', '    model: mock', '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color' }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  child = spawn(process.execPath, [join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  closed = once(child, 'close')
  const wake = () => { for (const check of [...pending]) check() }
  child.stdout.on('data', chunk => { out += chunk; wake() }); child.stderr.on('data', chunk => { err += chunk }); child.on('close', wake)
  await waitFor(0, text => text.includes('enter send'), 'startup')
  const session = /native-tui-[a-f0-9-]+/.exec(strip(out))?.[0]
  await turn('first')
  await line('/mode manual', 'Reset persistent shells to change permissions?')
  await input('\r', 'DONE first')
  await line('/mode', 'Interaction mode (current: off)')
  await input('\x1b', 'SHELL_GENERATION_1')
  await line('/permissions', 'Permission preset (current: workspace-write)')
  await input('\x1b', 'SHELL_GENERATION_1')
  checks.cancelKeepsPermissions = true
  await line('/mode manual', 'Reset persistent shells to change permissions?')
  await input('\x1b[B\r', 'Mode: manual mode')
  checks.modeRecovered = true
  await line('/permissions workspace-write', 'Permission preset: workspace-write')
  await turn('second')
  await line('/permissions read-only', 'Reset persistent shells to change permissions?')
  await input('\x1b[B\r', 'Permission preset: read-only')
  checks.nativeRecovered = true
  await turn('third')
  checks.newAgentEachTime = ['first', 'second', 'third'].every((stage, index) => results.get(stage)?.includes('SHELL_GENERATION_' + (index + 1)))
  checks.historyRetained = retainedHistory
  checks.sameSession = session !== undefined && [...strip(out).matchAll(/native-tui-[a-f0-9-]+/g)].every(match => match[0] === session)
  child.stdin.write('\x04')
  const [code, signal] = await closed
  const pass = code === 0 && signal === null && Object.keys(checks).length === 6 && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'checks', JSON.stringify(checks), 'RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) console.log(Object.fromEntries(results), strip(out).slice(-5000), err.slice(-2000))
  process.exitCode = pass ? 0 : 1
} catch (error) {
  console.error(error, strip(out).slice(-6500), err.slice(-2000))
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (closed) await closed.catch(() => {})
  await new Promise(resolve => server.close(resolve))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-permission-restart-')) throw new Error('Unexpected cleanup root: ' + root)
  rmSync(root, { recursive: true, force: true })
}
