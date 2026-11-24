import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

const exec = promisify(execFile)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = process.env.DSH_CLI_ENTRY
assert(cli, 'Set DSH_CLI_ENTRY to the target CLI')
const home = await mkdtemp(join(tmpdir(), 'dsh-worktree-probe-'))
console.log('Worktree evidence: ' + home)
const workspace = join(home, 'original')
const profile = join(home, 'profiles/tui')
await mkdir(workspace)
await mkdir(join(profile, 'node_modules'), { recursive: true })
const git = (...args) => exec('git', ['-C', workspace, ...args])
await git('init', '-b', 'main')
await writeFile(join(workspace, 'identity.txt'), 'ORIGINAL_DIR_PROBE\n')
const skill = join(workspace, '.dsh/skills/worktree-fixture')
await mkdir(skill, { recursive: true })
await writeFile(join(skill, 'SKILL.md'), '---\nname: worktree-fixture\ndescription: Worktree probe skill\n---\n\nFixture body\n')
await git('add', 'identity.txt', '.dsh/skills')
await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Worktree probe fixture')
await unlink(join(skill, 'SKILL.md'))

const toolCalls = new Map([
  ['WORKTREE_ENTER_PROBE', ['enter_worktree', { name: 'upgrade-probe' }]],
  ['WORKTREE_EXIT_PROBE', ['exit_worktree', {}]],
  ['WORKTREE_APPROVAL_PROBE', ['write', {
    file_path: 'guarded.txt', content: 'this write should be denied',
    sandbox_permissions: 'workspace-write', justification: 'Write to the worktree fixture',
  }]],
])
const server = createServer((req, res) => {
  void reply(req, res).catch(error => res.destroy(error))
})
async function reply(req, res) {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  const raw = Buffer.concat(await Array.fromAsync(req)).toString()
  const body = JSON.parse(raw)
  const title = raw.includes('Create a concise title')
  const prompt = body.messages.findLastIndex(message =>
    message.role === 'user' && [...toolCalls.keys()].some(key => JSON.stringify(message.content).includes(key)))
  const source = JSON.stringify(body.messages[prompt]?.content)
  const key = [...toolCalls.keys()].find(key => source?.includes(key))
  const [name, args] = toolCalls.get(key) ?? []
  const result = body.messages.slice(prompt + 1).some(message => message.role === 'tool')
  const call = !title && name !== undefined && !result
  if (call) assert(body.tools.some(tool => tool.function.name === name), 'Missing ' + name)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (delta, finish_reason) => res.write('data: ' + JSON.stringify({ id: 'worktree-fixture',
    object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  send({ role: 'assistant', ...(call ? { tool_calls: [{ index: 0, type: 'function', id: key,
    function: { name, arguments: JSON.stringify(args) } }] } : { content: title ? 'Worktree probe' : 'WORKTREE_TOOL_SETTLED' }) }, null)
  send({}, call ? 'tool_calls' : 'stop')
  res.end('data: [DONE]\n\n')
}

let child
let settled
let out = '', err = ''
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  await symlink(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'worktree-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: worktree
      name: '@deepseek-ai/dsh-experimental-worktree'
    - id: tool-worktree
      name: '@deepseek-ai/dsh-experimental-tool-worktree'
- id: native-tui
  config: { agentPreset: standard, theme: plain }
- id: llm-pi-ai
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${server.address().port}/v1
        apiKeyEnv: MOCK_API_KEY
        models: [{ id: probe, contextWindow: 128000, maxTokens: 4096 }]
- id: agent-default-model
  config: { provider: mock, model: probe }
`)
  child = spawn(process.execPath, [join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_CLI_ENTRY: cli, MOCK_API_KEY: 'fixture',
      DSH_NATIVE_TUI_NO_LAUNCHER: '1', FAKE_TTY_COLUMNS: '180', TERM: 'xterm-256color' },
  })
  settled = once(child, 'close')
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const step = async (pattern, keys) => {
    const offset = keys === undefined ? 0 : out.length
    if (keys !== undefined) child.stdin.write(keys)
    const deadline = Date.now() + 20_000
    while (!pattern.test(stripTerminalSequences(out.slice(offset)))) {
      assert(child.exitCode === null && Date.now() < deadline, 'Waiting for ' + pattern)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  await step(/enter send/u)
  await step(/ORIGINAL_DIR_PROBE/u, '/open identity.txt\r')
  await step(/WORKTREE_TOOL_SETTLED[\s\S]*enter send/u, 'WORKTREE_ENTER_PROBE\r')
  const records = (await git('worktree', 'list', '--porcelain')).stdout.trim().split('\n\n')
  const checkout = records.find(record => record.endsWith('branch refs/heads/upgrade-probe'))
  assert(checkout, 'Host must create the linked worktree')
  const path = checkout.split('\n')[0].slice('worktree '.length)
  await writeFile(join(path, 'identity.txt'), 'LINKED_DIR_PROBE\n')
  assert.match(out, /\x1b\]0;[^\x07]*upgrade-probe\x07/u)
  await step(/LINKED_DIR_PROBE/u, '/open identity.txt\r')
  await step(/Fixture body/u, '/skill read worktree-fixture\r')
  await step(/Ask DeepSeek Harness to do anything/u, '\x1b')
  await step(/Mode: manual mode/u, '/mode manual\r')
  await step(/Approval required/u, 'WORKTREE_APPROVAL_PROBE\r')
  await step(/WORKTREE_TOOL_SETTLED[\s\S]*enter send/u, '\r')
  await assert.rejects(access(join(path, 'guarded.txt')), { code: 'ENOENT' })
  await step(/Mode: off/u, '/mode off\r')
  await step(/WORKTREE_TOOL_SETTLED[\s\S]*enter send/u, 'WORKTREE_EXIT_PROBE\r')
  await step(/ORIGINAL_DIR_PROBE/u, '/open identity.txt\r')
  child.stdin.write('\x04')
  assert.deepEqual(await settled, [0, null])
  console.log('PASS worktree entry, path, title, skills, write approval, exit · ' + home)
} finally {
  if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await settled }
  await writeFile(join(home, 'terminal.txt'), stripTerminalSequences(out) + '\n' + err)
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
