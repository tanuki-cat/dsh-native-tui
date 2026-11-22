/** Real Host proof for the per-model threshold editor and pressure boundary. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'native-compaction-threshold-'))
const profile = join(home, 'profiles/tui')
const workspace = join(home, 'workspace')
const patch = join(profile, 'cordis.patch.yml')
const requests = []
let sampledTokens = 113100
let failSummary = false
let truncateSummary = false
let overflowNext = false
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/responses') { res.writeHead(404).end(); return }
    const body = JSON.parse(raw)
    const lastUser = JSON.stringify(body.input?.findLast(message => message.role === 'user'
      && /BOUNDARY_|SWITCH_|BELOW_PROBE|ABOVE_PROBE|OVERFLOW_PROBE/u.test(JSON.stringify(message))) ?? '')
    const kind = raw.includes('compaction engine') ? 'summary'
      : raw.includes('Create a concise title') ? 'title'
      : lastUser.includes('BOUNDARY_FIRST') ? 'first'
      : lastUser.includes('BOUNDARY_SECOND') ? 'second' : 'reply'
    requests.push({ kind, model: body.model, max: body.max_output_tokens })
    if (kind === 'summary' && failSummary) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic summary refused' } }))
      return
    }
    if (kind === 'reply' && lastUser.includes('OVERFLOW_PROBE') && overflowNext) {
      overflowNext = false
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'This model’s maximum context length is 147456 tokens. You requested 160000 tokens.', code: 'context_length_exceeded' } }))
      return
    }
    const text = kind === 'first' ? 'alpha '.repeat(800) + 'FIRST-COMPLETE'
      : kind === 'second' ? 'beta '.repeat(14700) + 'SECOND-COMPLETE'
      : kind === 'summary' ? 'Synthetic checkpoint.' : kind === 'title' ? 'Compaction probe' : 'REPLY-COMPLETE'
    const output = kind === 'second' ? 18400 : kind === 'first' ? 1200 : 12
    const total = kind === 'second' ? sampledTokens : 32000
    const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    send('response.created', { response: { id: 'threshold-probe', status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
    send('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text })
    send('response.output_item.done', { output_index: 0, item })
    const incomplete = kind === 'summary' && truncateSummary
    send(incomplete ? 'response.incomplete' : 'response.completed', { response: { id: 'threshold-probe',
      status: incomplete ? 'incomplete' : 'completed', output: [item],
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      usage: { input_tokens: total - output, output_tokens: output, total_tokens: total } } })
    res.end('data: [DONE]\n\n')
  })
})

function journals() {
  const directory = join(home, 'sessions')
  return readdirSync(directory, { recursive: true }).filter(path => path.endsWith('session.v4.jsonl.zstd')).flatMap(path => {
    const raw = readFileSync(join(directory, path))
    const events = []
    let start = 0
    for (let offset = 4; offset <= raw.length; offset += 1) {
      if (offset < raw.length && (offset + 4 > raw.length || raw.readUInt32LE(offset) !== 0xfd2fb528)) continue
      events.push(...zstdDecompressSync(raw.subarray(start, offset)).toString().trim().split('\n').map(JSON.parse))
      start = offset
    }
    return events
  })
}

async function verifyPresetMigration() {
  const cli = process.env.DSH_CLI_ENTRY ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const requireHost = createRequire(cli)
  const { composeEntries, loadOverlayPatches } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-app-boot')).href)
  const bundle = loadOverlayPatches('dsh', join(repo, 'presets/ptc.patch.yml'))
  const overrides = loadOverlayPatches('dsh', patch).filter(row => row.id === 'preset-ptc')
  assert.equal(overrides.length, 1)
  const shipped = bundle[0].insert[0]
  const instructions = preset => preset.config.plugins.find(row => row.id === 'agent-instructions')
  const compactor = preset => preset.config.plugins.find(row => row.id === 'compaction').config.find(row => row.id === 'compaction-basic')
  const upgraded = structuredClone(shipped)
  instructions(upgraded).config.maxBytes = 32768
  const newTool = { id: 'upgraded-tool', name: '@deepseek-ai/dsh-tool-todo', disabled: true }
  upgraded.config.plugins.push(newTool)
  const upgradedBundle = [{ insert: [upgraded] }]
  const [oldOverride] = composeEntries([upgradedBundle, overrides])
  assert.notEqual(instructions(oldOverride).config.maxBytes, 32768)
  const migrated = structuredClone(upgraded)
  const userTool = { id: 'custom-tool', name: '@deepseek-ai/dsh-tool-todo', disabled: true }
  migrated.config.plugins.push(userTool)
  compactor(migrated).config = structuredClone(compactor(oldOverride).config)
  const [effective] = composeEntries([upgradedBundle, [migrated]])
  assert.equal(instructions(effective).config.maxBytes, 32768)
  assert.ok(effective.config.plugins.some(row => row.id === newTool.id))
  assert.ok(effective.config.plugins.some(row => row.id === userTool.id))
  assert.deepEqual(compactor(effective).config.modelPolicies, [{ provider: 'mock', model: 'qwen', thresholdRatio: 0.77, headroomTokens: 1147, maxTokens: 7000 }])
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const dir of [join(profile, 'node_modules'), workspace, join(home, 'agents'), join(home, 'bundled')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'threshold-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  const initialPatch = [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: qwen', '            contextWindow: 147456', '            maxTokens: 32768',
    '          - id: inkling', '            contextWindow: 200000', '            maxTokens: 32768',
    '          - id: narrow', '            contextWindow: 96000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: ptc', '    theme: plain',
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: qwen', '',
  ].join('\n')
  writeFileSync(patch, initialPatch)
  const chromeLog = join(home, 'chrome.jsonl')
  const chromeTrace = pathToFileURL(join(repo, 'scripts/fake-tty-chrome-trace.mjs')).href
  const env = { PATH: process.env.PATH, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color',
    NODE_OPTIONS: '--import=' + chromeTrace, FAKE_TTY_GEOMETRY_LOG: chromeLog,
    FAKE_TTY_COLUMNS: '144', FAKE_TTY_ROWS: '42', ...(process.env.DSH_CLI_ENTRY ? { DSH_CLI_ENTRY: process.env.DSH_CLI_ENTRY } : {}) }
  const entry = join(repo, 'scripts/fake-tty-entry.mjs')
  const child = spawn(process.execPath, [entry, '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const waitUntil = async (condition, label) => {
    const until = Date.now() + 18000
    while (!condition()) {
      assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < until, 'Waiting for ' + label)
      await new Promise(resolve => setTimeout(resolve, 35))
    }
  }
  const wait = (pattern, offset = 0) => waitUntil(() => pattern.test(stripTerminalSequences(out.slice(offset))), pattern)
  const statusShowsBaseline = (route, visible) => waitUntil(() => {
    if (!existsSync(chromeLog)) return false
    const record = readFileSync(chromeLog, 'utf8').trim().split('\n').at(-1)
    const status = record ? JSON.parse(record).status : ''
    const model = route.split('/').at(-1)
    const baseline = /\b(?:Compaction baseline|base) ([\d.]+%)/u.exec(status)?.[1]
    return (status.startsWith(route + ' ') || status.startsWith(model + ' ')) && baseline === (visible ? '77%' : undefined)
  }, 'status for ' + route + (visible ? ' with baseline 77%' : ' without baseline'))
  const input = async (keys, pattern) => {
    const offset = out.length
    child.stdin.write(keys)
    await wait(pattern, offset)
    return stripTerminalSequences(out.slice(offset))
  }
  const summaries = () => requests.filter(request => request.kind === 'summary')
  try {
    await wait(/enter send/u)
    await statusShowsBaseline('mock/qwen', false)
    const originalSession = /native-tui-[0-9a-f-]{36}/u.exec(stripTerminalSequences(out))?.[0]
    assert.ok(originalSession)
    const defaultReport = await input('/context\r', /49,152 tokens/u)
    assert.doesNotMatch(defaultReport, /configured 80%/u)
    await input('/context threshold 90\r', /Use 77%/u)
    await input('\x1b', /enter send/u)
    assert.equal(readFileSync(patch, 'utf8'), initialPatch)
    await input('/context threshold 90\r', /Use 77%/u)
    await input('\r', /Save threshold/u)
    assert.equal(readFileSync(patch, 'utf8'), initialPatch)
    await input('\r', /Saved 77% threshold/u)
    await statusShowsBaseline('mock/qwen', false)
    assert.match(readFileSync(patch, 'utf8'), /thresholdRatio: 0\.77/u)
    await input('/reload\r', new RegExp(originalSession + '[\\s\\S]*enter send', 'u'))
    await statusShowsBaseline('mock/qwen', true)
    await input('/context\r', /113,541 tokens/u)
    await input('/model mock\/inkling\r', /Model selected: mock\/inkling/u)
    await statusShowsBaseline('mock/inkling', false)
    await input('/context\r', /101,696 tokens/u)
    await input('SWITCH_TO_INKLING\r', /REPLY-COMPLETE[\s\S]*Ready/u)
    await input('/model mock\/qwen\r', /Model selected: mock\/qwen/u)
    await statusShowsBaseline('mock/qwen', true)
    await input('SWITCH_TO_QWEN\r', /REPLY-COMPLETE[\s\S]*Ready/u)
    await input('/context\r', /113,541 tokens/u)

    await input('/new\r', /Switched to native-tui/u)
    await input('BOUNDARY_FIRST\r', /FIRST-COMPLETE[\s\S]*Ready/u)
    await input('BOUNDARY_SECOND\r', /SECOND-COMPLETE[\s\S]*Ready/u)
    await input('BELOW_PROBE\r', /REPLY-COMPLETE[\s\S]*Ready/u)
    assert.equal(summaries().length, 0)

    failSummary = true
    await input('/model mock\/narrow\r', /Model selected: mock\/narrow/u)
    await statusShowsBaseline('mock/narrow', false)
    await input('SWITCH_SHOULD_FAIL\r', /MODEL_SWITCH_COMPACTION_FAILED/u)
    await input('/context\r', /113,541 tokens\) · mock\/qwen/u)
    assert.equal(requests.some(request => request.model === 'narrow' && request.kind === 'reply'), false)
    assert.equal(summaries().length, 1)
    failSummary = false
    await input('/model mock\/qwen\r', /Model selected: mock\/qwen/u)
    overflowNext = true
    await input('OVERFLOW_PROBE\r', /REPLY-COMPLETE[\s\S]*Ready/u)
    assert.equal(summaries().length, 2)

    sampledTokens = 113541
    const opened = await input('/new\r', /Switched to native-tui-[0-9a-f-]{36}/u)
    const aboveSession = /Switched to (native-tui-[0-9a-f-]{36})/u.exec(opened)?.[1]
    assert.ok(aboveSession)
    await input('BOUNDARY_FIRST\r', /FIRST-COMPLETE[\s\S]*Ready/u)
    await input('BOUNDARY_SECOND\r', /SECOND-COMPLETE[\s\S]*Ready/u)
    await input('ABOVE_PROBE\r', /REPLY-COMPLETE[\s\S]*Ready/u)
    assert.equal(summaries().length, 3)
    // A separate cap confirmation preserves the percentage and affects /compact.
    const preview = await input('/context threshold 77\r', /Edit summary output limit/u)
    assert.match(preview, /Saving writes the preset configuration to this profile/u)
    await input('\x1b[B\r', /Applies to automatic summaries/u)
    await input('\x15' + '7000\r', /65,536 → 7,000/u)
    await input('\r', /Saved 77% threshold/u)
    await input('/reload\r', new RegExp(aboveSession + '[\\s\\S]*enter send', 'u'))
    truncateSummary = true
    await input('/compact\r', /Compaction could not produce a useful summary/u)
    truncateSummary = false
    await input('/compact\r', /Compacted \d+/u)
    assert.deepEqual(summaries().map(request => request.max), [65536, 65536, 65536, 7000, 7000])

    child.stdin.write('\x04')
    assert.deepEqual(await closed, [0, null])
    const dump = spawnSync(process.execPath, [entry, '--profile', 'tui', '--dump-config'], { cwd: workspace, env, encoding: 'utf8', timeout: 12000 })
    assert.equal(dump.status, 0, dump.stderr)
    assert.match(dump.stdout, /model: qwen\s+thresholdRatio: 0\.77\s+headroomTokens: 1147\s+maxTokens: 7000/u)
    const events = journals()
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 3)
    assert.ok(events.some(event => event.type === 'compaction/end' && JSON.stringify(event.data.error ?? '').includes('summarization truncated at the token cap')))
    await verifyPresetMigration()
    console.log('PASS 90% → 77%, cancel/confirm, resumed session, per-model status baseline, below/at pressure, switch refusal, overflow, /compact cap and truncation, preset migration')
  } catch (error) {
    console.error(stripTerminalSequences(out).slice(-6500), err.slice(-3500), requests)
    throw error
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => { child.kill('SIGKILL') }, 5000)
      try { await closed } finally { clearTimeout(force) }
    }
  }
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
