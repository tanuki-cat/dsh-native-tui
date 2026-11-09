/** Real Host + rendered-frame checks for the two status rows. Run after pnpm build. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-statusline-'))
const results = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    const title = body.includes('Create a concise title')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (choices, usage) => res.write('data: ' + JSON.stringify({
      id: 'statusline-probe', object: 'chat.completion.chunk', created: 1, model: 'status-model', choices, usage,
    }) + '\n\n')
    send([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
    setTimeout(() => {
      send([{ index: 0, delta: { content: title ? 'Statusline probe' : 'STATUSLINE DONE' }, finish_reason: null }])
      send([{ index: 0, delta: {}, finish_reason: 'stop' }])
      send([], { prompt_tokens: 24_000, completion_tokens: 12, total_tokens: 24_012 })
      res.end('data: [DONE]\n\n')
    }, title ? 0 : 350)
  })
})

async function run(fullscreen, width) {
  const label = (fullscreen ? 'fullscreen' : 'main-screen') + '-' + width
  const home = join(root, label), profile = join(home, 'profiles/tui')
  const workspace = join(root, 'workspace'), log = join(home, 'frames.jsonl')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'agents')); mkdirSync(join(home, 'bundled'))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'statusline-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-completions',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: status-model', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: minimal', '    fullscreen: ' + fullscreen,
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: status-model', '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color',
    FAKE_TTY_COLUMNS: String(width), FAKE_TTY_GEOMETRY_LOG: log,
  }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'),
    join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const closed = once(child, 'close')
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, phase) => {
    const deadline = Date.now() + 20_000
    while (!predicate(frames())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(label + ': ' + phase + ' failed')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  try {
    await waitFor(records => records.some(frame => frame.status.includes('Ready')), 'ready')
    child.stdin.write('check statusline\r')
    await waitFor(records => records.some(frame => frame.status.includes('Working') && frame.wait), 'working')
    await waitFor(records => records.some(frame => frame.status.includes('Ready') && /(?:Context \d+% used|ctx \d+%)/u.test(frame.status)), 'settled context')
    const records = frames()
    const ready = records.find(frame => frame.status.includes('Ready'))
    assert.match(ready.status, /(?:Context|ctx) —/u)
    const settled = records.at(-1)
    assert.ok(records.every(frame => frame.statusRow === frame.editorRow + 2), 'status must follow the editor bottom border')
    assert.ok(records.every(frame => !frame.overflow), 'no rendered row may exceed terminal width')
    assert.ok(records.every(frame => frame.footer.startsWith('off · ')), 'mode stays on the second status row')
    assert.ok(records.every(frame => frame.footer.includes('workspace-write')), 'native permissions must stay visible')
    assert.ok(records.every(frame => frame.status.includes('status-model')), 'model must remain visible')
    assert.ok(records.some(frame => frame.footer.includes('esc cancel')), 'running shortcut remains visible')
    child.stdin.write('\x04')
    const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    assert.ok(out.includes('STATUSLINE DONE'))
    results.push({ label, frames: records.length, status: settled.status, footer: settled.footer })
    console.log(label, 'PASS', JSON.stringify(results.at(-1)))
  } catch (error) {
    child.kill('SIGTERM')
    await closed
    console.error(label, 'stdout', out.slice(-3000), 'stderr', err.slice(-3000))
    throw error
  }
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  mkdirSync(join(root, 'workspace'))
  writeFileSync(join(root, 'workspace/package.json'), '{"private":true}')
  for (const fullscreen of [false, true]) {
    for (const width of [160, 60]) await run(fullscreen, width)
  }
  console.log('RESULT PASS', results.length, 'configurations')
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
