/** Real Host: native/PTC write updates, empty-file insertions, creates and /diff inspection. */
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

async function run(preset, fullscreen) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-write-diff-'))
  const profile = join(root, 'profiles/tui'), workspace = join(root, 'workspace'), log = join(root, 'frames.jsonl')
  const calls = [
    { name: 'read', args: { file_path: 'demo.ts' } },
    { name: 'read', args: { file_path: 'empty.ts' } },
    { name: 'write', args: { file_path: 'demo.ts', content: 'const value = 2\n' } },
    { name: 'write', args: { file_path: 'empty.ts', content: 'EMPTY_INSERTION\n' } },
    { name: 'write', args: { file_path: 'created.ts', content: ['CREATED_SOURCE', ...Array.from({ length: 10 }, (_, index) => '// row ' + index), 'CREATED_TAIL'].join('\n') + '\n' } },
  ]
  const respond = (res, call, index) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    send('response.created', { response: { id: 'write-diff', object: 'response', status: 'in_progress', output: [] } })
    if (call) {
      const args = preset === 'ptc' ? { description: call.name, code: 'return await tools.' + call.name + '(' + JSON.stringify(call.args) + ')' } : call.args
      const item = { id: 'item-' + index, type: 'function_call', call_id: 'call-' + index,
        name: preset === 'ptc' ? 'run_code' : call.name, arguments: JSON.stringify(args) }
      send('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
      send('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments })
      send('response.output_item.done', { output_index: 0, item })
    } else {
      const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'WRITE DIFF DONE', annotations: [] }] }
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      send('response.output_text.delta', { output_index: 0, delta: 'WRITE DIFF DONE' })
      send('response.output_item.done', { output_index: 0, item })
    }
    send('response.completed', { response: { id: 'write-diff', status: 'completed', output: [],
      usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240 } } })
    res.end('data: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      if (raw.includes('Create a concise title')) { respond(res); return }
      const outputs = (JSON.parse(raw).input ?? []).filter(item => item.type === 'function_call_output')
      const done = new Set(outputs.map(item => item.call_id))
      const index = calls.findIndex((_call, index) => !done.has('call-' + index))
      respond(res, calls[index], index)
    })
  })
  let child, closed, out = '', err = ''
  const label = preset + '-' + (fullscreen ? 'fullscreen' : 'main-screen')
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    for (const dir of [join(profile, 'node_modules'), workspace, join(root, 'agents'), join(root, 'bundled')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'demo.ts'), 'const value = 1\n')
    writeFileSync(join(workspace, 'empty.ts'), '')
    writeFileSync(join(workspace, 'package.json'), '{"private":true}')
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'write-diff-profile', private: true,
      dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
    symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
      '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
      '        models:', '          - id: diff-model', '            contextWindow: 128000', '            maxTokens: 4096',
      '- id: native-tui', '  config:', '    agentPreset: ' + preset, '    runCodeDisplay: compact', '    fullscreen: ' + fullscreen,
      '- id: agent-default-model', '  config:', '    provider: mock', '    model: diff-model', '',
    ].join('\n'))
    const env = { ...process.env, DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'),
      MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: '100', FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' }
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
    child.stdin.write('run the write diff probe\r')
    await waitFor(() => frames().some(frame => frame.status.includes('Ready') && frame.lines.some(line => line.includes('WRITE DIFF DONE'))), 'answer')
    for (const call of calls.filter(call => call.name === 'write')) assert.equal(readFileSync(join(workspace, call.args.file_path), 'utf8'), call.args.content)
    const records = frames(), transcript = records.flatMap(frame => frame.lines).join('\n')
    assert.ok(transcript.includes('• write demo.ts') && transcript.includes('1 - const value = 1') && transcript.includes('1 + const value = 2'))
    assert.ok(transcript.includes('• write empty.ts') && transcript.includes('1 + EMPTY_INSERTION'))
    assert.ok(transcript.includes('• write created.ts') && transcript.includes('1  CREATED_SOURCE') && !transcript.includes('1 + CREATED_SOURCE'))
    assert.ok(!records.some(frame => frame.overflow))
    const inspect = async (command, expected) => {
      const offset = out.length
      child.stdin.write(command + '\r')
      await waitFor(() => strip(out.slice(offset)).includes('Diff · write') && strip(out.slice(offset)).includes(expected), command)
      child.stdin.write('\x1b')
      await waitFor(() => !frames().at(-1)?.lines.some(line => line.includes('Esc closes')), 'close ' + command)
    }
    await inspect('/diff', '+ EMPTY_INSERTION')
    await inspect('/diff ' + (preset === 'ptc' ? 5 : 2), '- const value = 1')
    child.stdin.write('\x0f')
    await waitFor(() => frames().at(-1)?.lines.some(line => line.includes('CREATED_TAIL')), 'expanded source')
    assert.ok(!frames().at(-1).lines.some(line => line.includes('1 + CREATED_SOURCE')))
    child.stdin.write('\x04')
    let deadline
    let exit
    try {
      exit = await Promise.race([closed, new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(label + ': shutdown timed out')), 20_000)
      })])
    } finally { clearTimeout(deadline) }
    const [code, signal] = exit
    assert.equal(signal, null, 'probe must exit without a signal')
    assert.equal(code, 0)
    console.log(label, 'PASS: write update -old/+new; empty update +insertion; create source; /diff latest and indexed')
  } catch (error) {
    console.error(label, 'stdout', strip(out).slice(-6000), 'stderr', err.slice(-3000))
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

for (const preset of ['standard', 'ptc']) for (const fullscreen of [false, true]) await run(preset, fullscreen)
console.log('RESULT PASS 4 configurations')
