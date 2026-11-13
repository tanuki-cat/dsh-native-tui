/** Real Host + rendered-frame checks for the workspace branch in the status row. Run after pnpm build. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-git-branch-'))
const results = []
const model = 'mock-model'
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: model, name: model, context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

async function run(label, workspace, check) {
  const home = join(root, 'home-' + label), profile = join(home, 'profiles/tui'), log = join(home, 'frames.jsonl')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'agents'))
  mkdirSync(join(home, 'bundled'))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'git-branch-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-completions',
    '        baseURL: http://127.0.0.1:' + port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: ' + model, '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: minimal', '    theme: plain', '    fullscreen: false',
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: ' + model, '',
  ].join('\n'))
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'),
    join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', COLORTERM: 'truecolor',
      FAKE_TTY_COLUMNS: '200', FAKE_TTY_ROWS: '40', FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', chunk => { err += String(chunk) })
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, phase) => {
    const deadline = Date.now() + 20_000
    while (!predicate(frames())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(label + ': ' + phase + ' failed' + (err === '' ? '' : '\n' + err.slice(-2000)))
      }
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  try {
    await waitFor(records => records.some(frame => frame.status.includes('Ready')), 'ready frame')
    const ready = frames().filter(frame => frame.status.includes('Ready')).at(-1)
    check(ready.status)
    results.push({ label, status: ready.status })
    child.stdin.write('\x04')
    const [code, signal] = await once(child, 'close')
    assert.equal(code, 0, label + ': clean exit')
    assert.equal(signal, null, label + ': no signal')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

try {
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, '.git'), { recursive: true })
  writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/probe-branch\n')
  await run('repository', checkout, status => {
    assert.match(status, /(?:^| · )git probe-branch(?: · |$)/u, 'branch follows the workspace')
    assert.ok(status.indexOf('git probe-branch') < status.indexOf('Ready'), 'branch sits before the state')
  })
  const plain = join(root, 'plain')
  mkdirSync(plain)
  await run('outside-git', plain, status => {
    assert.doesNotMatch(status, /(?:^| · )git /u, 'a workspace outside Git shows no branch')
  })
  console.log('PASS git-branch probe')
  for (const result of results) console.log(result.label + ': ' + result.status)
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
