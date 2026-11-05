/** Keyless real-Host probe for rc.1 Schedule, observation policy and native/PTC patches. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = process.env.DSH_CLI_ENTRY
assert(entry, 'Set DSH_CLI_ENTRY to an isolated rc.1 lib/bin.js')
assert.equal(JSON.parse(await readFile(resolve(dirname(entry), '../package.json'), 'utf8')).version, '0.2.2-rc.1')
const root = await mkdtemp(join(repo, '.tmp/rc1-capabilities-'))
const cases = new Map(), children = new Set(), sockets = new Set()
let defaultOff = false, serverFailure
console.log('Capability evidence: ' + root)
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    try {
      const body = JSON.parse(raw)
      appendFileSync(join(root, 'requests.jsonl'), JSON.stringify(body) + '\n')
      appendFileSync(join(root, 'tools.log'), JSON.stringify(body.messages.filter(message => message.role === 'tool'), null, 2) + '\n')
      const text = JSON.stringify(body.messages)
      const tail = body.messages
      const ptc = body.tools?.some(tool => tool.function?.name === 'run_code')
      const scenario = [...cases.values()].find(item => text.includes(item.marker))
      const calls = []
      let answer = 'SCHEDULE_DELIVERY_OK'
      if (JSON.stringify(body.messages).includes('Create a concise title')) answer = 'Capability probe'
      else if (text.includes('CAPABILITY_DEFAULT')) {
        assert(!body.tools?.some(tool => tool.function?.name === 'apply_patch'), 'apply_patch must default off')
        defaultOff = true; answer = 'CAPABILITY_DEFAULT_OK'
      } else if (scenario) {
        scenario.requests += 1
        assert(scenario.requests <= 6, 'Unexpected tool loop for ' + scenario.marker)
        const tools = tail.filter(message => message.role === 'tool')
        const patchComplete = tools.some(message => {
          try {
            const value = JSON.parse(message.content)
            const patch = Array.isArray(value) ? value[0] : value
            return patch?.phase === 'commit' && patch.cancelled === false && patch.operations?.length === 3
              && patch.operations.every(operation => operation.status === 'completed')
          } catch { return false }
        })
        if (tools.length === 0) calls.push({ name: 'edit', args: { file_path: scenario.old, old_string: 'BEFORE_OLD', new_string: 'UNREAD_CHANGE' } })
        else if (!text.includes('BEFORE_DELETE')) {
          assert(text.includes('requires reading') || text.includes('FS_NOT_OBSERVED') || text.includes('file has not been read'), 'Expected read-before-edit refusal: ' + JSON.stringify(tools))
          scenario.observedRefusal = true
          calls.push({ name: 'read', args: { file_path: scenario.old } }, { name: 'read', args: { file_path: scenario.deleted } })
        } else if (!text.includes('Success. Updated') && !patchComplete) {
          calls.push({ name: 'apply_patch', args: { input: scenario.patch } })
        } else answer = 'CAPABILITY_PATCH_OK'
        if (calls.length > 0) {
          if (ptc) {
            const code = calls.map(call => 'await tools.' + call.name + '(' + JSON.stringify(call.args) + ')').join(', ')
            calls.splice(0, calls.length, { name: 'run_code', args: { description: 'Exercise guarded patch capability', code: 'return [' + code + ']' } })
          } else assert(body.tools?.some(tool => tool.function?.name === 'apply_patch'), 'Opt-in patch missing from native tools')
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = delta => res.write('data: ' + JSON.stringify({ id: 'capability', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      send({ role: 'assistant' })
      if (calls.length > 0) send({ tool_calls: calls.map((call, index) => ({ index, id: 'probe-' + index + '-' + (scenario?.requests ?? 0), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
      else send({ content: answer })
      res.write('data: ' + JSON.stringify({ id: 'capability', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } catch (error) {
      serverFailure = error
      console.error(error)
      res.destroy(error)
      for (const child of children) child.kill('SIGTERM')
    }
  })
})
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const port = server.address().port
const clean = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
async function run(preset, enabled) {
  const label = preset + (enabled ? '-enabled' : '-default'), home = join(root, label), profile = join(home, 'profiles/tui')
  const old = join(home, 'old.txt'), deleted = join(home, 'deleted.txt'), moved = join(home, 'moved.txt'), added = join(home, 'added.txt')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await symlink(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  await writeFile(old, 'BEFORE_OLD\n'); await writeFile(deleted, 'BEFORE_DELETE\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-completions',
    '        baseURL: http://127.0.0.1:' + port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: mock-model', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: agent-default-model', '  config: { provider: mock, model: mock-model }',
    '- id: native-tui', '  config: { agentPreset: ' + preset + ' }', '',
  ].join('\n'))
  for (const target of [old, deleted, moved, added]) assert(target.startsWith(root + '/'), 'Patch target must stay in the probe root: ' + target)
  const marker = 'CAPABILITY_PATCH_' + preset
  const scenario = { marker, old, deleted, requests: 0, observedRefusal: false,
    patch: ['*** Begin Patch', '*** Add File: ' + added, '+CREATED', '*** Update File: ' + old, '*** Move to: ' + moved, '@@', '-BEFORE_OLD', '+AFTER_MOVE', '*** Delete File: ' + deleted, '*** End Patch'].join('\n') }
  cases.set(marker, scenario)
  const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_CLI_ENTRY: entry, DSH_HOME: home, DSH_NATIVE_TUI_NO_LAUNCHER: '1', MOCK_API_KEY: 'dummy',
      DSH_NATIVE_TUI_APPLY_PATCH: enabled ? '1' : '0', TERM: 'xterm-256color' } })
  children.add(child)
  let output = '', errors = '', phase = 0, offset = 0, taskId, timedOut = false, failure
  const send = text => { offset = clean(output).length; child.stdin.write(text + '\r') }
  const advance = () => {
    const text = clean(output).slice(offset)
    if (phase === 0 && text.includes('enter send')) { phase = 1; send(enabled ? '/schedule add 3600 RC1_TASK' : 'CAPABILITY_DEFAULT') }
    else if (!enabled && phase === 1 && text.includes('CAPABILITY_DEFAULT_OK') && text.includes('idle')) { phase = 10; child.stdin.write('\x04') }
    else if (enabled && phase === 1 && text.includes('Task created:')) {
      taskId = text.match(/schedule-[0-9a-f-]+/)?.[0]; assert(taskId); phase = 2; send('/schedule list')
    } else if (phase === 2 && text.includes('Host tasks:') && text.includes('RC1_TASK')) { phase = 3; send('/schedule pause ' + taskId) }
    else if (phase === 3 && text.includes('Task edit:') && text.includes('paused')) { phase = 4; send('/schedule resume ' + taskId) }
    else if (phase === 4 && text.includes('Task edit:') && text.includes('active')) { phase = 5; send('/schedule history ' + taskId) }
    else if (phase === 5 && text.includes('Host task delivery history:')) { phase = 6; send('/schedule delete ' + taskId) }
    else if (phase === 6 && text.includes('Delete Host task')) { phase = 7; offset = clean(output).length; child.stdin.write('\x1b[B\r') }
    else if (phase === 7 && text.includes('Task delete:') && text.includes('true')) { phase = 8; send(marker) }
    else if (phase === 8 && text.includes('CAPABILITY_PATCH_OK') && text.includes('idle')) { phase = 10; child.stdin.write('\x04') }
  }
  child.stdout.on('data', data => { output += data; try { advance() } catch (error) { failure = error; child.kill('SIGTERM') } })
  child.stderr.on('data', data => { errors += data })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 90000)
  try {
    const [code, signal] = await once(child, 'exit')
    await writeFile(join(home, 'output.txt'), clean(output) + '\nSTDERR\n' + errors)
    assert(!timedOut && !failure && code === 0 && signal === null && phase === 10, label + ' phase=' + phase + ' ' + (failure?.stack ?? serverFailure?.stack ?? '') + errors.slice(-3000) + clean(output).slice(-4000))
    if (enabled) {
      assert(scenario.observedRefusal, 'Observation policy was not exercised')
      assert.equal(await readFile(moved, 'utf8'), 'AFTER_MOVE\n')
      assert.equal(await readFile(added, 'utf8'), 'CREATED\n')
      await assert.rejects(access(old)); await assert.rejects(access(deleted))
    }
    console.log(JSON.stringify({ preset, applyPatch: enabled, schedule: enabled, observedRefusal: scenario.observedRefusal, filesVerified: enabled, requests: scenario.requests }))
  } finally { clearTimeout(timer); children.delete(child) }
}
try {
  await run('standard', false); assert(defaultOff)
  await run('standard', true); await run('ptc', true)
  console.log('PASS rc.1 capabilities evidence=' + root)
} finally {
  for (const child of children) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}) }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
