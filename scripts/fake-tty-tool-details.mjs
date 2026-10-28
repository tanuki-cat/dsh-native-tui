/** Real Host PTC dispatch, approval inspection, and file-effect regression in a private profile. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.cwd(), root = mkdtempSync(join(tmpdir(), 'dsh-details-'))
const workspace = join(root, 'workspace'), home = join(root, 'home'), profile = join(home, 'profiles/tui')
const deniedFile = join(workspace, 'denied.txt'), allowedFile = join(workspace, 'allowed.txt')
const checks = {}, seen = new Map(), results = new Map()
let out = '', err = '', child, closed, tick, hard, timedOut = false
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const command = stage => 'printf ' + (stage === 'reject' ? 'TOOL_DETAILS_DENIED' : 'TOOL_DETAILS_ALLOWED') + ' > ' + JSON.stringify(stage === 'reject' ? deniedFile : allowedFile)
const program = stage => (stage === 'reject' ? [
  'await tools.skill({ name: \"fixture-alpha\" })',
  'await tools.skill({ name: \"fixture-beta\" })',
  'await tools.mcp__fixture__lookup({ filePath: "src/mcp-target.ts" })',
  'await tools.todo_write({ todos: [{ content: "Track src/task-target.ts", status: "in_progress" }, { content: "Verify result", status: "pending" }] })',
].join('\n') + '\n' : '') + 'return await tools.bash(' + JSON.stringify({ description: 'DESCRIPTION_IS_NOT_THE_COMMAND', command: command(stage), workdir: workspace }) + ')'
const server = createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw), messages = body.messages ?? []
    const stage = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).reverse()
      .map(text => /DETAILSPROBE:(reject|allow)/.exec(text)?.[1]).find(Boolean)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-details', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant' })
    if (!stage || raw.includes('Create a concise title')) send({ content: 'Tool details' })
    else if (!seen.has(stage)) {
      seen.set(stage, true)
      send({ tool_calls: [{ index: 0, id: 'call-details-' + stage, type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ description: 'Exercise tool details ' + stage, code: program(stage) }) } }] })
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return
    } else {
      results.set(stage, JSON.stringify([...messages].reverse().find(message => message.role === 'tool')?.content))
      send({ content: 'DONE ' + stage })
    }
    send({}, 'stop'); res.end('data: [DONE]\n\n')
  })
})
let phase = 'ready', baseline = 0, detailBaseline = 0
const input = text => { child.stdin.write(text) }
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  mkdirSync(workspace); mkdirSync(join(profile, 'node_modules/fixture-details'), { recursive: true })
  mkdirSync(join(home, 'agents')); mkdirSync(join(home, 'bundled'))
  for (const name of ['fixture-alpha', 'fixture-beta']) {
    const dir = join(workspace, '.dsh/skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: ' + name, 'description: Read-only display fixture.', '---', '# ' + name, 'Fixture content only.', ''].join('\n'))
  }
  writeFileSync(join(workspace, 'package.json'), '{"name":"details-workspace","private":true}\n')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'details-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo, 'fixture-details': 'file:./node_modules/fixture-details' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'node_modules/fixture-details/package.json'), '{"name":"fixture-details","type":"module","exports":"./index.js"}')
  writeFileSync(join(profile, 'node_modules/fixture-details/index.js'), [
    'export const inject = ["tools"]',
    'export function apply(ctx) { ctx.tools.register({ name: "mcp__fixture__lookup", description: "Return the fixture path.",',
    'parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"], additionalProperties: false }, output: { schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, render: (_args, result) => [{ type: "text", text: result.path }] },',
    'execute: async args => ({ path: args.filePath }) }) }',
  ].join('\n'))
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- insert:', '    - id: fixture-details', '      name: fixture-details',
    '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      mock:',
    '        api: openai-completions', '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: mock-model', '            name: mock-model', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  name: dsh-native-tui', '  config:', '    agentPreset: ptc', '    runCodeDisplay: compact',
    '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: mock', '    model: mock-model', '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color' }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  child = spawn(process.execPath, [join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  closed = once(child, 'close')
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  tick = setInterval(() => {
    const text = strip(out), fresh = text.slice(baseline)
    if (phase === 'ready' && text.includes('enter send')) { baseline = text.length; input('DETAILSPROBE:reject\r'); phase = 'mcp'; return }
    if (phase === 'mcp' && fresh.includes('Approval required')) {
      checks.mcpPreview = fresh.includes('mcp fixture.lookup src/mcp-target.ts')
      input('\r'); baseline = text.length; phase = 'todo'; return
    }
    if (phase === 'todo' && fresh.includes('Approval required')) {
      checks.todoPreview = fresh.includes('todo_write 2 tasks') && fresh.includes('src/task-target.ts')
      input('\r'); baseline = text.length; phase = 'bash'; return
    }
    if (phase === 'bash' && fresh.includes('Approval required')) {
      checks.bashPreview = fresh.includes('bash printf TOOL_DETAILS_DENIED') && !fresh.includes('DESCRIPTION_IS_NOT_THE_COMMAND')
      detailBaseline = text.length; input('\x1b[B\x1b[B\x1b[B\r'); phase = 'details'; return
    }
    if (phase === 'details' && text.slice(detailBaseline).includes('Approval request details')) {
      if (!text.slice(detailBaseline).includes('TOOL_DETAILS_DENIED')) { input('\x1b[6~'); return }
      checks.fullDetails = true; checks.inspectionHasNoEffect = !existsSync(deniedFile)
      baseline = text.length; input('\x1b'); phase = 'reject'; return
    }
    if (phase === 'reject' && fresh.includes('Approval required')) { input('\x1b[B\r'); baseline = text.length; phase = 'rejected'; return }
    if (phase === 'rejected' && fresh.includes('DONE reject') && fresh.lastIndexOf('enter send') > fresh.lastIndexOf('DONE reject')) {
      checks.rejection = !existsSync(deniedFile) && /rejected/i.test(results.get('reject') ?? '')
      checks.skillSummary = text.includes('├ skill fixture-alpha') && text.includes('├ skill fixture-beta')
      checks.cardSummary = text.includes('mcp fixture.lookup src/mcp-target.ts') && text.includes('├ bash printf TOOL_DETAILS_DENIED') && text.includes('├ todo_write 2 tasks')
      baseline = text.length; input('DETAILSPROBE:allow\r'); phase = 'allow'; return
    }
    if (phase === 'allow' && fresh.includes('Approval required')) {
      checks.allowedPreview = fresh.includes('bash printf TOOL_DETAILS_ALLOWED')
      input('\r'); baseline = text.length; phase = 'allowed'; return
    }
    if (phase === 'allowed' && fresh.includes('DONE allow') && fresh.lastIndexOf('enter send') > fresh.lastIndexOf('DONE allow')) {
      checks.allowEffect = existsSync(allowedFile) && readFileSync(allowedFile, 'utf8') === 'TOOL_DETAILS_ALLOWED'
      input('\x04'); phase = 'done'
    }
    if (fresh.includes('DONE reject') && !['rejected', 'allow', 'allowed', 'done'].includes(phase)) {
      phase = 'failed'; input('\x04')
    }
  }, 100)
  hard = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
  const [code, signal] = await closed
  const pass = !timedOut && code === 0 && signal === null && phase === 'done' && Object.keys(checks).length === 10 && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'timedOut', timedOut)
  console.log('checks', JSON.stringify(checks)); console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) console.log(strip(out).slice(-14000), err.slice(-4000), Object.fromEntries(results))
  process.exitCode = pass ? 0 : 1
} finally {
  clearInterval(tick); clearTimeout(hard)
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (closed) await closed.catch(() => {})
  await new Promise(resolve => { server.close(resolve) })
  rmSync(root, { recursive: true, force: true })
}
