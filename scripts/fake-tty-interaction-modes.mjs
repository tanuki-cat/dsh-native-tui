/** Real Loader, sandbox, plan review, and Auto reviewer; all effects stay in private temporary fixtures. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const presentation = process.argv[2] ?? 'native'
if (!['native', 'ptc'].includes(presentation)) throw new Error('Expected native or ptc')
const root = mkdtempSync(join(tmpdir(), 'dsh-modes-'))
const workspace = join(root, 'workspace'), home = join(root, 'home')
const counts = new Map(), results = new Map(), checks = {}
let reviews = 0, out = '', err = '', child, closed, tick, hard, timedOut = false
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const file = stage => join(workspace, stage + '.txt')
function action(stage, step) {
  if (stage === 'plan-keep' || (stage === 'plan-accept' && step === 0))
    return { name: 'exit_plan_mode', args: { plan: '# Temporary fixture plan\n\nCreate one regression fixture after approval.' } }
  const target = stage === 'plan-accept' ? 'after-plan' : stage
  return { name: 'write', args: { file_path: file(target), content: 'MODE BODY ' + target,
    ...(stage === 'manual-edit' ? { sandbox_permissions: 'workspace-write', justification: 'Create this private temporary regression fixture once.' } : {}) } }
}
const server = createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw), messages = body.messages ?? []
    const review = raw.includes('final authorization reviewer for exactly one pending tool call')
    const title = raw.includes('Create a concise title')
    const users = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).reverse()
    const stage = users.map(text => /MODEPROBE:([a-z-]+)/.exec(text)?.[1]).find(Boolean)
    const base = { id: 'chatcmpl-modes', object: 'chat.completion.chunk', created: 1, model: 'mock-model' }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant' })
    if (review) {
      reviews += 1
      send({ content: raw.includes('auto-malformed.txt') ? 'NOT JSON' : raw.includes('auto-denied.txt')
        ? '{"risk":"high","decision":"deny","reason":"Regression rejection"}'
        : '{"risk":"low","decision":"allow"}' })
    } else if (title || !stage) send({ content: 'Mode probe' })
    else {
      const step = counts.get(stage) ?? 0
      counts.set(stage, step + 1)
      const limit = stage === 'plan-accept' ? 2 : 1
      if (step < limit) {
        const call = action(stage, step)
        const name = presentation === 'ptc' ? 'run_code' : call.name
        const args = presentation === 'ptc' ? { description: 'Exercise ' + stage, code: 'return await tools.' + call.name + '(' + JSON.stringify(call.args) + ')' } : call.args
        send({ tool_calls: [{ index: 0, id: 'call-' + stage + '-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        send({}, 'tool_calls')
        res.end('data: [DONE]\n\n')
        return
      }
      const last = [...messages].reverse().find(message => message.role === 'tool')
      results.set(stage, JSON.stringify(last?.content ?? ''))
      send({ content: 'DONE ' + stage })
    }
    send({}, 'stop')
    res.end('data: [DONE]\n\n')
  })
})
let index = 0, started = false, answered = false, baseline = 0
const tasks = [
  { input: 'MODEPROBE:edit-default', done: 'DONE edit-default', check: text => {
    checks.default = text.includes('accept edits') && existsSync(file('edit-default')) && !text.includes('Approval required')
  } },
  { input: '/mode manual', done: 'Mode: manual mode' },
  { input: 'MODEPROBE:manual-edit', done: 'DONE manual-edit', approval: 'reject', check: () => {
    checks.manual = answered && !existsSync(file('manual-edit')) && /rejected/i.test(results.get('manual-edit') ?? '')
  } },
  { input: '/mode accept-edits', done: 'Mode: accept edits' },
  { input: '/mode plan', done: 'Mode: plan mode' },
  { input: 'MODEPROBE:plan-write', done: 'DONE plan-write', check: () => {
    checks.planGuard = !existsSync(file('plan-write')) && (results.get('plan-write') ?? '').includes('Plan mode blocks')
  } },
  { input: 'MODEPROBE:plan-keep', done: 'DONE plan-keep', review: 'keep', check: text => {
    checks.planRejected = answered && text.includes('plan mode') && (results.get('plan-keep') ?? '').includes('keep planning')
  } },
  { input: 'MODEPROBE:plan-accept', done: 'DONE plan-accept', review: 'approve', check: text => {
    checks.planApproved = answered && existsSync(file('after-plan')) && text.includes('accept edits')
  } },
  { input: '/mode auto', done: 'Mode: auto mode', consent: true },
  { input: 'MODEPROBE:auto-allowed', done: 'DONE auto-allowed', check: text => {
    checks.autoAllowed = existsSync(file('auto-allowed')) && reviews > 0 && !text.includes('Approval required')
  } },
  { input: 'MODEPROBE:auto-denied', done: 'DONE auto-denied', approval: 'reject', check: () => {
    checks.autoDenied = answered && !existsSync(file('auto-denied'))
  } },
  { input: 'MODEPROBE:auto-malformed', done: 'DONE auto-malformed', check: () => {
    checks.autoFailure = !existsSync(file('auto-malformed')) && /review.*failed/i.test(results.get('auto-malformed') ?? '')
  } },
]
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  mkdirSync(workspace)
  mkdirSync(join(home, 'profiles/tui/node_modules'), { recursive: true })
  mkdirSync(join(home, 'agents')); mkdirSync(join(home, 'bundled'))
  writeFileSync(join(workspace, 'package.json'), '{"name":"mode-probe","private":true}\n')
  writeFileSync(join(home, 'profiles/tui/cordis.yml'), '[]\n')
  writeFileSync(join(home, 'profiles/tui/package.json'), JSON.stringify({ name: 'mode-probe-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + process.cwd() }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  symlinkSync(process.cwd(), join(home, 'profiles/tui/node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(home, 'profiles/tui/cordis.patch.yml'), [
    '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      mock:',
    '        api: openai-completions', '        baseURL: http://127.0.0.1:' + port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: mock-model', '            name: mock-model', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  name: dsh-native-tui', '  config:', '    agentPreset: ' + (presentation === 'ptc' ? 'ptc' : 'standard'),
    '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: mock', '    model: mock-model', '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color' }
  delete env.DSH_PERMISSION_MODE
  delete env.DSH_TOOLS_MODE
  child = spawn(process.execPath, [join(process.cwd(), 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  closed = once(child, 'close')
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  tick = setInterval(() => {
    const text = strip(out)
    if (!text.includes('enter send')) return
    if (index === tasks.length) { child.stdin.write('\x04'); index += 1; return }
    if (index > tasks.length) return
    const task = tasks[index]
    if (!started) {
      baseline = text.length; started = true; answered = false
      child.stdin.write(task.input + '\r')
      return
    }
    const fresh = text.slice(baseline)
    if (!answered && task.consent && fresh.includes('Auto mode · experimental')) {
      answered = true; child.stdin.write('\x1b[B\r'); return
    }
    if (!answered && task.approval && fresh.includes('Approval required')) {
      answered = true; child.stdin.write('\x1b[B\r'); return
    }
    if (!answered && task.review && fresh.includes('Approve this plan and leave plan mode?')) {
      answered = true; child.stdin.write(task.review === 'keep' ? '\x1b[B\r' : '\r'); return
    }
    const completed = fresh.includes(task.done) && (task.input.startsWith('/') || fresh.lastIndexOf('enter send') > fresh.lastIndexOf(task.done))
    if (completed) { task.check?.(fresh); index += 1; started = false }
  }, 100)
  hard = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
  const [code, signal] = await closed
  let pass = !timedOut && code === 0 && signal === null && index > tasks.length && Object.keys(checks).length === 8 && Object.values(checks).every(Boolean)
  clearInterval(tick); clearTimeout(hard)
  if (pass && presentation === 'native') {
    const id = /Session: ([a-z0-9-]+)/.exec(strip(out))?.[1]
    checks.resume = false
    if (id !== undefined) {
      let resumed = ''
      child = spawn(process.execPath, [join(process.cwd(), 'scripts/fake-tty-entry.mjs'), '--profile', 'tui', '--resume', id], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
      closed = once(child, 'close')
      child.stdout.on('data', chunk => { resumed += chunk; out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      tick = setInterval(() => {
        const text = strip(resumed)
        if (text.includes('auto mode · EXP') && text.includes('enter send')) {
          checks.resume = true
          clearInterval(tick)
          child.stdin.write(String.fromCharCode(4))
        }
      }, 100)
      hard = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 15000)
      const [resumeCode, resumeSignal] = await closed
      checks.resume = checks.resume && resumeCode === 0 && resumeSignal === null && !timedOut
    }
    pass = pass && checks.resume
  }
  console.log('EXIT', presentation, code, signal, 'task', index, 'timedOut', timedOut, 'reviews', reviews)
  console.log('checks', JSON.stringify(checks))
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  if (!pass) console.log(strip(out).slice(-11000), err.slice(-3000), 'RESULTS', Object.fromEntries(results))
  process.exitCode = pass ? 0 : 1
} finally {
  clearInterval(tick); clearTimeout(hard)
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (closed) await closed.catch(() => {})
  await new Promise(resolve => { server.close(resolve) })
  rmSync(root, { recursive: true, force: true })
}
