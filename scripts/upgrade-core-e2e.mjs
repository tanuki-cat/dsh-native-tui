/** Keyless integration probe. Set DSH_CLI_ENTRY to the matching installed CLI. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = process.env.DSH_CLI_ENTRY
assert(entry, 'Set DSH_CLI_ENTRY to the target CLI lib/bin.js')
const manifest = JSON.parse(await readFile(resolve(dirname(entry), '../package.json'), 'utf8'))
assert.equal(manifest.version, '0.2.2-rc.1')
const root = await mkdtemp(join(repo, '.tmp/upgrade-core-'))
const probeFile = join(root, 'probe.txt')
await writeFile(probeFile, 'UPGRADE_READ_OK\n')
const requests = []
const sockets = new Set()
const server = createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    try {
      const body = JSON.parse(raw)
      const title = JSON.stringify(body.messages).includes('Create a concise title')
      if (!title) requests.push(body)
      const lastUser = body.messages.findLastIndex(message => message.role === 'user')
      const tool = body.messages.slice(lastUser + 1).findLast(message => message.role === 'tool')
      const ptc = body.tools?.some(tool => tool.function?.name === 'run_code')
      const canRead = body.tools?.some(tool => tool.function?.name === 'read')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = delta => res.write('data: ' + JSON.stringify({ id: 'upgrade', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      send({ role: 'assistant' })
      if (title) send({ content: 'Upgrade probe' })
      else if (!ptc && !canRead) send({ content: 'UPGRADE_FINAL_OK' })
      else if (tool) send({ content: JSON.stringify(tool).includes('UPGRADE_READ_OK') ? 'UPGRADE_FINAL_OK' : 'UPGRADE_TOOL_FAILED ' + JSON.stringify(tool) })
      else send({ tool_calls: [{ index: 0, id: 'upgrade-read-' + requests.length, type: 'function', function: {
        name: ptc ? 'run_code' : 'read', arguments: JSON.stringify(ptc
          ? { description: 'Read upgrade fixture', code: 'return await tools.read({ file_path: ' + JSON.stringify(probeFile) + ' })' }
          : { file_path: probeFile }),
      } }] })
      res.write('data: ' + JSON.stringify({ id: 'upgrade', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: title || tool || (!ptc && !canRead) ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } catch (error) { res.destroy(error) }
  })
})
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
const clean = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const active = new Set()

async function runBlank(home, preset) {
  const before = requests.length
  const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_CLI_ENTRY: entry, DSH_HOME: home, MOCK_API_KEY: 'dummy', DSH_NATIVE_TUI_NO_LAUNCHER: '1', TERM: 'xterm-256color' },
  })
  active.add(child)
  let output = '', errors = '', phase = 0, marker = 0, timedOut = false
  const send = command => { marker = clean(output).length; child.stdin.write(command + String.fromCharCode(13)) }
  child.stdout.on('data', data => {
    output += data
    const text = clean(output).slice(marker)
    if (phase === 0 && text.includes('enter send')) { phase = 1; send('/reload') }
    else if (phase === 1 && text.includes('Reloading dsh') && text.slice(text.indexOf('Reloading dsh')).includes('enter send')) { phase = 2; send('probe blank') }
    else if (phase === 2 && requests.length >= before + (preset === 'minimal' ? 1 : 2) && text.includes('UPGRADE_FINAL_OK') && text.includes('idle')) { phase = 3; child.stdin.write(String.fromCharCode(4)) }
  })
  child.stderr.on('data', data => { errors += data })
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
  try {
    const [code, signal] = await once(child, 'exit')
    await writeFile(join(home, 'blank-output.txt'), clean(output) + String.fromCharCode(10) + errors)
    assert(!timedOut && code === 0 && signal === null && phase === 3, 'blank ' + preset + ' phase=' + phase + ' ' + errors.slice(-2000) + clean(output).slice(-3000))
    const calls = requests.slice(before)
    assert(calls.length > 0 && calls.every(call => call.model === 'model-a'), 'blank Session must use the configured fallback')
    console.log(JSON.stringify({ preset, blankReload: true, model: 'model-a', requests: calls.length }))
  } finally { clearTimeout(timeout); active.delete(child) }
}

async function run(home, preset, resume) {
  const before = requests.length
  const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui', ...(resume ? ['--resume', resume] : [])], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_CLI_ENTRY: entry, DSH_HOME: home, MOCK_API_KEY: 'dummy', DSH_NATIVE_TUI_NO_LAUNCHER: '1', TERM: 'xterm-256color' },
  })
  active.add(child)
  let output = '', errors = '', phase = 0, marker = 0, timedOut = false
  const advance = () => {
    const text = clean(output).slice(marker)
    const send = command => { marker = clean(output).length; child.stdin.write(command + '\r') }
    if (phase === 0 && text.includes('enter send')) { phase = 1; send(resume ? '/status' : '/model mock/model-b') }
    else if (phase === 1 && text.includes(resume ? 'Model:' : 'Model selected: mock/model-b')) {
      if (resume) { assert(text.includes('Model: mock/model-b') && text.includes('Reasoning: provider default')); phase = 3; send('probe resumed') }
      else { phase = 2; send('/reasoning default') }
    }
    else if (phase === 2 && text.includes('Reasoning effort: provider default')) { phase = 3; send('probe ' + preset) }
    else if (phase === 3 && requests.length >= before + (preset === 'minimal' ? 1 : 2) && text.includes('UPGRADE_FINAL_OK') && text.includes('idle')) { phase = 4; send('/reload') }
    else if (phase === 4 && text.includes('Reloading dsh') && text.slice(text.indexOf('Reloading dsh')).includes('enter send')) { phase = 5; send('/status') }
    else if (phase === 5 && text.includes('Model:')) { assert(text.includes('Model: mock/model-b') && text.includes('Reasoning: provider default')); phase = 6; child.stdin.write('\x04') }
  }
  child.stdout.on('data', data => { output += data; try { advance() } catch (error) { errors += error.stack; child.kill('SIGTERM') } })
  child.stderr.on('data', data => { errors += data })
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
  try {
    const [code, signal] = await once(child, 'exit')
    await writeFile(join(home, resume ? 'resume-output.txt' : 'output.txt'), clean(output) + '\nSTDERR\n' + errors)
    assert(!timedOut && signal === null && code === 0 && phase === 6, preset + ' phase=' + phase + ' exit=' + code + ' signal=' + signal + '\n' + errors.slice(-4000) + '\n' + clean(output).slice(-4000))
    const modelCalls = requests.slice(before)
    assert(modelCalls.length >= (preset === 'minimal' ? 1 : 2), 'expected model/tool roundtrip')
    if (preset === 'standard' || preset === 'cordis') {
      const names = modelCalls[0].tools.map(tool => tool.function.name)
      assert(names.includes('list_agents') && names.includes('list_subagent_models'), 'missing shared subagent tools')
    }
    assert(modelCalls.every(call => call.model === 'model-b'), 'UI and provider route differ')
    const sessionId = clean(output).match(/Session: (native-tui-[0-9a-f-]+)/)?.[1]
    assert(sessionId, 'missing resume identity')
    console.log(JSON.stringify({ preset, resumed: Boolean(resume), model: 'model-b', requests: modelCalls.length, reload: true, toolRoundtrip: preset !== 'minimal', sessionId }))
    return sessionId
  } finally { clearTimeout(timeout); active.delete(child) }
}

try {
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const home = join(root, preset), profile = join(home, 'profiles/tui')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await symlink(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'upgrade-' + preset, private: true, dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: model-a
            contextWindow: 128000
            maxTokens: 4096
            reasoningEfforts: { low: low, high: high }
          - id: model-b
            contextWindow: 128000
            maxTokens: 4096
            reasoningEfforts: { low: low, high: high }
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: ${preset}
- id: agent-default-model
  config:
    provider: mock
    model: model-a
`)
    await runBlank(home, preset)
    const session = await run(home, preset)
    const saved = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    const differentDefault = saved.replace(/(id: agent-default-model[\s\S]*?\bmodel:\s*)model-b/, '$1model-a')
    assert.notEqual(differentDefault, saved, 'reset deployment default before resume')
    await writeFile(join(profile, 'cordis.patch.yml'), differentDefault)
    await run(home, preset, session)
  }
  console.log('PASS core=' + manifest.version + ' evidence=' + root)
} finally {
  for (const child of active) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}) }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
