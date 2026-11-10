/** Real Host: native/PTC multi-file edits, compact summaries, details and /diff identities. */
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
const files = Array.from({ length: 4 }, (_, index) => ({ path: 'src/file-' + index + '.ts',
  before: Array.from({ length: 8 }, (_, row) => 'OLD_' + index + '_' + row).join('\n'),
  after: Array.from({ length: 8 }, (_, row) => 'NEW_' + index + '_' + row).join('\n'),
}))

async function run(preset, fullscreen, columns, theme) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-edit-group-'))
  const workspace = join(root, 'workspace'), profile = join(root, 'profiles/tui'), log = join(root, 'frames.jsonl')
  const label = [preset, fullscreen ? 'fullscreen' : 'main-screen', columns, theme].join('-')
  const response = (res, phase) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    send('response.created', { response: { id: 'edit-group', status: 'in_progress', output: [] } })
    if (phase < 2) {
      const name = phase === 0 ? 'read' : 'edit'
      const calls = files.map((file, index) => ({ id: name + '-' + index, name,
        args: phase === 0 ? { file_path: file.path } : { file_path: file.path, old_string: file.before, new_string: file.after } }))
      const dispatched = preset === 'ptc' ? [{ id: name + '-root', name: 'run_code', args: {
        description: name + ' four files', code: 'const results = [];\n' + calls.map(call => 'results.push(await tools.' + name + '(' + JSON.stringify(call.args) + '));').join('\n') + '\nreturn results',
      } }] : calls
      for (const [index, call] of dispatched.entries()) {
        const item = { id: call.id, type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }
        send('response.output_item.added', { output_index: index, item: { ...item, arguments: '' } })
        send('response.function_call_arguments.delta', { output_index: index, delta: item.arguments })
        send('response.output_item.done', { output_index: index, item })
      }
    } else {
      const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'MULTI EDIT DONE', annotations: [] }] }
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      send('response.output_text.delta', { output_index: 0, delta: 'MULTI EDIT DONE' })
      send('response.output_item.done', { output_index: 0, item })
    }
    send('response.completed', { response: { id: 'edit-group', status: 'completed', output: [], usage: { input_tokens: 1200, output_tokens: 60, total_tokens: 1260 } } })
    res.end('data: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      if (raw.includes('Create a concise title')) { response(res, 2); return }
      const done = new Set((JSON.parse(raw).input ?? []).filter(item => item.type === 'function_call_output').map(item => item.call_id))
      response(res, done.has(preset === 'ptc' ? 'edit-root' : 'edit-3') ? 2 : done.has(preset === 'ptc' ? 'read-root' : 'read-3') ? 1 : 0)
    })
  })
  let child, closed, out = '', err = ''
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    for (const dir of [join(workspace, 'src'), join(profile, 'node_modules'), join(root, 'agents'), join(root, 'bundled')]) mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(workspace, file.path), file.before + '\n')
    writeFileSync(join(workspace, 'package.json'), '{"private":true}')
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'edit-group-probe', private: true,
      dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
    symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
      '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
      '        models:', '          - id: edit-model', '            contextWindow: 128000', '            maxTokens: 4096',
      '- id: native-tui', '  config:', '    agentPreset: ' + preset, '    runCodeDisplay: compact', '    fullscreen: ' + fullscreen, '    theme: ' + theme,
      '- id: agent-default-model', '  config:', '    provider: mock', '    model: edit-model', '',
    ].join('\n'))
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'),
      MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: String(columns), FAKE_TTY_ROWS: '40',
      FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' }
    delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
    child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
    const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const waitFor = async (predicate, stage) => {
      const until = Date.now() + 30_000
      while (!predicate()) {
        if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage + ' failed')
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    }
    await waitFor(() => strip(out).includes('enter send'), 'startup')
    child.stdin.write('edit the four files\r')
    await waitFor(() => frames().some(frame => frame.status.includes('Ready') && frame.lines.some(line => line.includes('MULTI EDIT DONE'))), 'answer')
    for (const file of files) assert.equal(readFileSync(join(workspace, file.path), 'utf8'), file.after + '\n')
    const records = frames(), transcript = records.flatMap(frame => frame.lines).join('\n')
    assert.ok(transcript.includes('• Edited 4 files (+32 -32)'), 'one summary must cover four files')
    for (const [index, file] of files.entries()) {
      assert.ok(transcript.includes('└ ' + file.path + ' (+8 -8)'), 'file header: ' + file.path)
      assert.ok(transcript.includes('- OLD_' + index + '_0') && transcript.includes('+ NEW_' + index + '_7'), 'applied diff preview: ' + file.path)
    }
    assert.ok(!records.some(frame => frame.overflow), 'all text rows must fit')
    if (!fullscreen) assert.ok(!out.includes('\x1b[3J'), 'automatic grouping must preserve native history')
    let offset = frames().length
    child.stdin.write('\x0f')
    await waitFor(() => frames().slice(offset).some(frame => frame.lines.some(line => line.includes('NEW_3_3'))), 'expanded diff detail')
    offset = frames().length
    child.stdin.write('\x0f')
    await waitFor(() => frames().slice(offset).some(frame => frame.lines.some(line => line.includes('Show details')) && !frame.lines.some(line => line.includes('NEW_3_3'))), 'collapse detail')
    const inspect = async (command, expected) => {
      const start = out.length
      child.stdin.write(command + '\r')
      await waitFor(() => strip(out.slice(start)).includes('Diff · edit') && strip(out.slice(start)).includes(expected), command)
      child.stdin.write('\x1b')
      await waitFor(() => !frames().at(-1)?.lines.some(line => line.includes('Esc closes')), 'close pager')
    }
    await inspect('/diff', 'NEW_3_3')
    await inspect('/diff ' + (preset === 'ptc' ? 6 : 4), 'NEW_0_3')
    child.stdin.write('\x04')
    let deadline
    const exit = await Promise.race([closed, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(label + ': shutdown timed out')), 20_000)
    })]).finally(() => { clearTimeout(deadline) })
    assert.equal(exit[1], null); assert.equal(exit[0], 0)
    console.log(label, 'PASS: Edited 4 files (+32 -32), per-file (+8 -8), actual writes, expand/collapse, /diff latest/indexed')
  } catch (error) {
    console.error(label, strip(out).slice(-5000), err.slice(-2000))
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
  await run(preset, fullscreen, 100, 'dark')
  await run(preset, fullscreen, 50, 'light')
}
console.log('RESULT PASS 8 configurations')
