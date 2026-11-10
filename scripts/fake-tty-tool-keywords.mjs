/** Real Host: action-only highlighting for native and compact PTC tools. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const calls = [
  { name: 'read', args: { file_path: 'MixedCase.ts' } },
  { name: 'grep', args: { pattern: 'KEYWORD_FIXTURE', path: '.' } },
  { name: 'glob', args: { pattern: '*.ts', path: '.' } },
]

async function run(preset, fullscreen, width, theme) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-keywords-'))
  const profile = join(root, 'profiles/tui'), workspace = join(root, 'workspace'), log = join(root, 'frames.jsonl')
  const label = [preset, fullscreen ? 'fullscreen' : 'main-screen', width, theme].join('-')
  let served = []
  const respond = (res, call, index) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    send('response.created', { response: { id: 'keywords', object: 'response', status: 'in_progress', output: [] } })
    if (call) {
      const args = preset === 'ptc' ? { description: call.name, code: 'return await tools.' + call.name + '(' + JSON.stringify(call.args) + ')' } : call.args
      const item = { id: 'item-' + index, type: 'function_call', call_id: 'call-' + index,
        name: preset === 'ptc' ? 'run_code' : call.name, arguments: JSON.stringify(args) }
      send('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
      send('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments })
      send('response.output_item.done', { output_index: 0, item })
    } else {
      const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'KEYWORDS DONE', annotations: [] }] }
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      send('response.output_text.delta', { output_index: 0, delta: 'KEYWORDS DONE' })
      send('response.output_item.done', { output_index: 0, item })
    }
    send('response.completed', { response: { id: 'keywords', status: 'completed', output: [],
      usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240 } } })
    res.end('data: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      if (raw.includes('Create a concise title')) { respond(res); return }
      served = (JSON.parse(raw).input ?? []).filter(item => item.type === 'function_call_output')
      const done = new Set(served.map(item => item.call_id))
      const index = calls.findIndex((_call, index) => !done.has('call-' + index))
      respond(res, calls[index], index)
    })
  })
  let child, closed, out = '', err = ''
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    for (const dir of [join(profile, 'node_modules'), workspace, join(root, 'agents'), join(root, 'bundled')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'MixedCase.ts'), 'export const KEYWORD_FIXTURE = 1\n')
    writeFileSync(join(workspace, 'package.json'), '{"private":true}')
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'keywords-profile', private: true,
      dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
    symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
      '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
      '        models:', '          - id: keyword-model', '            contextWindow: 128000', '            maxTokens: 4096',
      '- id: native-tui', '  config:', '    agentPreset: ' + preset, '    runCodeDisplay: compact',
      '    fullscreen: ' + fullscreen, '    theme: ' + theme,
      '- id: agent-default-model', '  config:', '    provider: mock', '    model: keyword-model', '',
    ].join('\n'))
    const env = { ...process.env, DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'),
      MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: String(width), FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' }
    delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
    child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
    const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const waitFor = async (predicate, stage) => {
      const until = Date.now() + 20_000
      while (!predicate()) {
        if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage + ' failed')
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    }
    await waitFor(() => strip(out).includes('enter send'), 'startup')
    child.stdin.write('check tool keywords\r')
    await waitFor(() => frames().some(frame => frame.status.includes('Ready') && frame.lines.some(line => line.includes('KEYWORDS DONE'))), 'answer')
    const records = frames(), rows = records.flatMap(frame => frame.rawLines)
    const accent = text => '\x1b[' + (theme === 'light' ? '38;5;25' : '38;5;117') + 'm' + text + '\x1b[39m'
    const expected = preset === 'ptc'
      ? [['Read', 'MixedCase.ts'], ['Search', 'KEYWORD_FIXTURE'], ['Search', '*.ts']]
      : [['Read', 'MixedCase.ts'], ['Search', '"KEYWORD_FIXTURE" .'], ['Search', '"*.ts" .']]
    for (const [action, target] of expected) {
      assert.ok(rows.some(row => row.includes(accent(action) + ' ' + target)), action + ' must be highlighted separately from ' + target)
    }
    if (preset === 'ptc') assert.ok(rows.some(row => strip(row).includes('• Ran code') && row.includes(accent('code'))), 'PTC heading must use settled tense')
    assert.ok(!records.some(frame => frame.overflow), 'frames must fit the terminal width')
    assert.equal(served.length, calls.length)
    assert.ok(JSON.stringify(served).includes('KEYWORD_FIXTURE') && JSON.stringify(served).includes('MixedCase.ts'), 'real tools must return fixture data')
    assert.ok(!rows.some(row => strip(row).includes('└ error')), 'tool calls must succeed')
    child.stdin.write('\x04')
    const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    console.log(label, 'PASS: Read/Search keyword ANSI, literal targets, successful Host calls, bounded frames')
  } catch (error) {
    console.error(label, 'stdout', strip(out).slice(-5000), 'stderr', err.slice(-2000))
    throw error
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(force) }
    }
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
}

for (const preset of ['standard', 'ptc']) for (const fullscreen of [false, true]) {
  for (const [width, theme] of [[100, 'dark'], [50, 'light']]) await run(preset, fullscreen, width, theme)
}
console.log('RESULT PASS 8 configurations')
