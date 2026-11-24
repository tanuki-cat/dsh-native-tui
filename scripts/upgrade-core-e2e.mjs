/** Keyless integration probe. Set DSH_CLI_ENTRY to the matching installed CLI. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { unzipSync } from 'fflate'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = process.env.DSH_CLI_ENTRY
assert(entry, 'Set DSH_CLI_ENTRY to the target CLI lib/bin.js')
const manifest = JSON.parse(await readFile(resolve(dirname(entry), '../package.json'), 'utf8'))
const tuiVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const expected = process.env.DSH_EXPECTED_CORE ?? tuiVersion
assert.equal(manifest.version, expected, 'CLI version ' + manifest.version + ' does not match expected ' + expected)
const tarball = process.env.DSH_TUI_TGZ
const baselineCli = process.env.DSH_BASELINE_CLI_ENTRY
const baselineTui = process.env.DSH_BASELINE_TUI_TGZ
assert(Boolean(baselineCli) === Boolean(baselineTui), 'Set both DSH_BASELINE_CLI_ENTRY and DSH_BASELINE_TUI_TGZ for cross-version recovery')
if (baselineCli) {
  const { version } = JSON.parse(await readFile(resolve(dirname(baselineCli), '../package.json'), 'utf8'))
  assert.equal(version, '0.2.2-rc.5')
  assert(tarball, 'Set DSH_TUI_TGZ to verify cross-version recovery against the packed upgrade')
}
const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'upgrade-core-'))
console.log('Upgrade evidence: ' + root)
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
          ? { description: 'Read upgrade fixture', code: 'inspect(await tools.read({ file_path: ' + JSON.stringify(probeFile) + ' }))' }
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
    else if (phase === 2 && requests.length >= before + (preset === 'minimal' ? 1 : 2) && text.includes('UPGRADE_FINAL_OK') && text.includes('Ready')) { phase = 3; child.stdin.write(String.fromCharCode(4)) }
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

async function run(home, preset, resume, fixture = {}) {
  const before = requests.length
  const child = spawn(process.execPath, [join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui', ...(resume ? ['--resume', resume] : [])], {
    cwd: fixture.cwd ?? repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_CLI_ENTRY: fixture.cli ?? entry, DSH_HOME: home, MOCK_API_KEY: 'dummy', DSH_NATIVE_TUI_NO_LAUNCHER: '1', TERM: 'xterm-256color' },
  })
  active.add(child)
  let output = '', errors = '', phase = 0, marker = 0, timedOut = false
  const advance = () => {
    const text = clean(output).slice(marker)
    const send = command => { marker = clean(output).length; child.stdin.write(command + '\r') }
    if (phase === 0 && text.includes('enter send')) { phase = 1; send(resume ? '/status' : '/model mock/model-b') }
    else if (phase === 1 && text.includes(resume ? 'Model:' : 'Model selected: mock/model-b')) {
      if (resume) {
        assert(text.includes('Model: mock/model-b') && text.includes('Reasoning: provider default'))
        if (fixture.expectDirectory) { phase = 7; send('/open identity.txt') }
        else { phase = 3; send('probe resumed') }
      }
      else { phase = 2; send('/reasoning default') }
    }
    else if (phase === 2 && text.includes('Reasoning effort: provider default')) {
      if (fixture.attachment) { phase = 8; send('/attach ' + fixture.attachment) }
      else { phase = 3; send('probe ' + preset) }
    }
    else if (phase === 7 && text.includes(fixture.expectDirectory)) { phase = 3; send('probe resumed') }
    else if (phase === 8 && text.includes('Attached file:')) { phase = 3; send('probe baseline history') }
    else if (phase === 3 && requests.length >= before + (preset === 'minimal' ? 1 : 2) && text.includes('UPGRADE_FINAL_OK') && text.includes('Ready')) { phase = 4; send('/reload') }
    else if (phase === 4 && text.includes('Reloading dsh') && text.slice(text.indexOf('Reloading dsh')).includes('enter send')) { phase = 5; send('/status') }
    else if (phase === 5 && text.includes('Model:')) {
      assert(text.includes('Model: mock/model-b') && text.includes('Reasoning: provider default'))
      if (fixture.verifyZip) { phase = 9; send('/export zip ' + fixture.verifyZip) }
      else { phase = 6; child.stdin.write('\x04') }
    }
    else if (phase === 9 && text.includes('Exported ZIP bundle:')) { phase = 6; child.stdin.write('\x04') }
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
    if (fixture.expectHistory) assert.match(JSON.stringify(modelCalls[0].messages), /probe baseline history/u)
    if (fixture.verifyZip) {
      const files = unzipSync(await readFile(fixture.verifyZip))
      const attachmentEntry = Object.keys(files).find(key => key.startsWith('attachments/') && key.endsWith('-restore.txt'))
      assert(attachmentEntry)
      assert.equal(Buffer.from(files[attachmentEntry]).toString(), 'RC5_ATTACHMENT_BYTES\n')
    }
    const sessionId = clean(output).match(/Session: (native-tui-[0-9a-f-]+)/)?.[1]
    assert(sessionId, 'missing resume identity')
    console.log(JSON.stringify({ preset, resumed: Boolean(resume), model: 'model-b', requests: modelCalls.length, reload: true, toolRoundtrip: preset !== 'minimal', sessionId }))
    return sessionId
  } finally { clearTimeout(timeout); active.delete(child) }
}

async function prepareProfile(home, preset, bundle, cli, version) {
  const profile = join(home, 'profiles/tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  const profileManifest = join(profile, 'package.json')
  await writeFile(profileManifest, JSON.stringify({
    name: 'upgrade-' + preset,
    private: true,
    dependencies: bundle === undefined ? { 'dsh-native-tui': 'link:' + repo } : {},
    dsh: { profile: { bundles: bundle === undefined ? ['@deepseek-ai/dsh-base', 'dsh-native-tui'] : ['@deepseek-ai/dsh-base'] } },
  }))
  if (bundle === undefined) {
    await symlink(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  } else {
    const result = await execFileAsync(process.execPath, [cli, 'plugin', '--profile', 'tui', 'add', resolve(bundle)], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' },
      timeout: 180_000,
    })
    await writeFile(join(home, 'install-output.txt'), result.stdout + '\n' + result.stderr)
    const installed = createRequire(profileManifest).resolve('dsh-native-tui/package.json')
    assert.equal(JSON.parse(await readFile(installed, 'utf8')).version, version)
  }
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
  return profile
}

async function verifyLegacyDirectoryEvent(home, sessionId) {
  const directory = join(home, 'sessions')
  const journal = (await readdir(directory, { recursive: true }))
    .find(path => path.includes(sessionId) && path.endsWith('session.v4.jsonl.zstd'))
  assert(journal, 'Expected a persistent rc.5 session')
  const raw = await readFile(join(directory, journal))
  let start = 0
  for (let end = 4; end <= raw.length; end++) {
    if (end < raw.length && (end + 4 > raw.length || raw.readUInt32LE(end) !== 0xfd2fb528)) continue
    const events = zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
    if (events.includes('"type":"working-directory/change"')) return
    start = end
  }
  assert.fail('Expected the rc.5 working directory event in the copied Session')
}

try {
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const home = join(root, preset)
    const profile = await prepareProfile(home, preset, tarball, entry, tuiVersion)
    await runBlank(home, preset)
    const session = await run(home, preset)
    const saved = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    const differentDefault = saved.replace(/(id: agent-default-model[\s\S]*?\bmodel:\s*)model-b/, '$1model-a')
    assert.notEqual(differentDefault, saved, 'reset deployment default before resume')
    await writeFile(join(profile, 'cordis.patch.yml'), differentDefault)
    await run(home, preset, session)
  }
  if (baselineCli && baselineTui) {
    const original = join(root, 'original-workspace')
    const moved = join(root, 'legacy-directory')
    await mkdir(original)
    await mkdir(moved)
    await writeFile(join(original, 'identity.txt'), 'ORIGINAL_WORKSPACE_OK\n')
    await writeFile(join(moved, 'identity.txt'), 'LEGACY_WORKSPACE\n')
    const attachment = join(original, 'restore.txt')
    await writeFile(attachment, 'RC5_ATTACHMENT_BYTES\n')
    for (const legacy of [false, true]) {
      const suffix = legacy ? 'legacy-directory' : 'ordinary'
      const before = join(root, 'rc5-' + suffix)
      const profile = await prepareProfile(before, 'standard', baselineTui, baselineCli, '0.2.2-rc.5')
      if (legacy) {
        await writeFile(join(profile, 'record-legacy.mjs'), `export const inject = ['workingDirectory']
export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!agent.session.snapshotEvents().some(event => event.type === 'working-directory/change'))
      await ctx.workingDirectory.set(agent, ${JSON.stringify(moved)}, signal)
    return next()
  })
}`)
        const patch = join(profile, 'cordis.patch.yml')
        await writeFile(patch, await readFile(patch, 'utf8') + '- insert:\n    - id: record-legacy\n      name: ./record-legacy.mjs\n')
      }
      const session = await run(before, 'standard', undefined, { cli: baselineCli, cwd: original, attachment })
      if (legacy) await verifyLegacyDirectoryEvent(before, session)
      const after = join(root, 'upgraded-' + suffix)
      await prepareProfile(after, 'standard', tarball, entry, tuiVersion)
      for (const area of ['sessions', 'attachments']) await cp(join(before, area), join(after, area), { recursive: true })
      await run(after, 'standard', session, { cwd: original, expectDirectory: 'ORIGINAL_WORKSPACE_OK', expectHistory: true, verifyZip: join(after, 'restored.zip') })
      console.log('PASS rc.5 recovery ' + suffix)
    }
  }
  console.log('PASS core=' + manifest.version + ' tui=' + tuiVersion + ' packed=' + (tarball !== undefined) + ' evidence=' + root)
} finally {
  for (const child of active) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}) }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
}
