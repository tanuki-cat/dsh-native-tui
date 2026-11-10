/** Real Host: reasoning → write → edit/diff → native approval → shell → Markdown answer. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-presentation-'))
const content = ['const before = 1', ...Array.from({ length: 17 }, (_, index) => '// source row ' + (index + 2))].join('\n') + '\n'
const command = "printf TOOL_EXECUTED > shell-ran.txt; printf 'TOOL OUTPUT\\n'"
const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let served = []
let activePreset = 'standard'

function respond(res, call, reasoning, text) {
  if (call && activePreset === 'ptc') call = { ...call, name: 'run_code', args: {
    description: call.name, code: 'return await tools.' + call.name + '(' + JSON.stringify(call.args) + ')',
  } }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  send('response.created', { response: { id: 'presentation', object: 'response', status: 'in_progress', output: [] } })
  if (reasoning) {
    send('response.output_item.added', { output_index: 0, item: { id: 'reasoning', type: 'reasoning', summary: [] } })
    send('response.reasoning_summary_text.delta', { output_index: 0, summary_index: 0, delta: reasoning })
    send('response.output_item.done', { output_index: 0, item: { id: 'reasoning', type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] } })
  }
  if (call) {
    const item = { id: call.id, type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }
    const output_index = reasoning ? 1 : 0
    send('response.output_item.added', { output_index, item: { ...item, arguments: '' } })
    send('response.function_call_arguments.delta', { output_index, delta: item.arguments })
    send('response.output_item.done', { output_index, item })
  } else {
    const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.output_text.delta', { output_index: 0, delta: text })
    send('response.output_item.done', { output_index: 0, item })
  }
  send('response.completed', { response: { id: 'presentation', status: 'completed', output: [], usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240 } } })
  res.end('data: [DONE]\n\n')
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
    if (raw.includes('Create a concise title')) { respond(res, undefined, undefined, 'Presentation probe'); return }
    const body = JSON.parse(raw)
    const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output')
    served = outputs
    const done = new Set(outputs.map(item => item.call_id))
    if (!done.has('presentation-write')) respond(res, { id: 'presentation-write', name: 'write', args: { file_path: 'demo.ts', content } }, 'PRESENTATION THOUGHT: inspect the requested changes.\n', undefined)
    else if (!done.has('presentation-edit')) respond(res, { id: 'presentation-edit', name: 'edit', args: { file_path: 'demo.ts', old_string: 'const before = 1', new_string: 'const after = 2' } })
    else if (!done.has('presentation-shell')) respond(res, { id: 'presentation-shell', name: 'bash', args: { command, description: 'Run the presentation probe' } })
    else respond(res, undefined, undefined, '**PRESENTATION DONE**')
  })
})

async function run(fullscreen, decision, preset = 'standard', display = 'detailed') {
  activePreset = preset
  served = []
  const label = (fullscreen ? 'fullscreen' : 'main-screen') + '-' + decision + (preset === 'ptc' ? '-ptc-' + display : '')
  const home = join(root, label), profile = join(home, 'profiles/tui'), workspace = join(home, 'workspace'), log = join(home, 'frames.jsonl')
  const pendingAck = join(home, 'pending-frame-ack')
  const shellHeading = preset === 'ptc' ? '• Ran run_code · bash' : '• Ran printf'
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  for (const dir of [workspace, join(home, 'agents'), join(home, 'bundled')]) mkdirSync(dir)
  writeFileSync(join(workspace, 'package.json'), '{"private":true}')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'presentation-profile', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo, 'approval-gate-probe': 'file:./node_modules/approval-gate-probe' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  cpSync(join(repo, 'scripts/approval-gate-probe'), join(profile, 'node_modules/approval-gate-probe'), { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- insert:', '    - id: approval-gate-probe', '      name: approval-gate-probe',
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: presentation-model', '            reasoning: true', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: ' + preset, '    runCodeDisplay: ' + display, '    thinkingDisplay: detailed', '    fullscreen: ' + fullscreen,
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: presentation-model', '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'),
    MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: '100', FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1',
    DSH_PROBE_PENDING_ACK: pendingAck }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
    { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const closed = once(child, 'close')
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, stage) => {
    const until = Date.now() + 20_000
    while (!predicate(strip(out), frames())) {
      if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage + ' failed')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  try {
    await waitFor(text => text.includes('enter send'), 'startup')
    child.stdin.write('run the presentation probe\r')
    await waitFor((_text, records) => records.some(frame => frame.rawLines.some(line => strip(line).includes(shellHeading)
      && line.includes('\x1b[33m• '))), 'pending shell frame')
    writeFileSync(pendingAck, '')
    await waitFor(text => text.includes('1. Allow once') && text.includes('Reason:'), 'approval')
    child.stdin.write((decision === 'allow' ? '1' : '2') + '\r')
    await waitFor((_text, records) => records.some(frame => frame.status.includes('Ready')
      && frame.lines.some(line => line.includes('PRESENTATION DONE'))), 'answer')
    assert.equal(readFileSync(join(workspace, 'demo.ts'), 'utf8'), content.replace('const before = 1', 'const after = 2'))
    assert.equal(existsSync(join(workspace, 'shell-ran.txt')), decision === 'allow')
    const records = frames(), transcript = records.flatMap(frame => frame.lines).join('\n')
    assert.ok(transcript.includes('• Write demo.ts') && transcript.includes('• Edit demo.ts'))
    assert.ok(transcript.includes('(+1 -1)') && transcript.includes('1 - const before = 1') && transcript.includes('1 + const after = 2'))
    assert.ok(transcript.includes(preset === 'ptc' ? '• Ran run_code' : '• Ran printf') && transcript.includes('PRESENTATION THOUGHT'))
    assert.ok(transcript.includes('• PRESENTATION DONE'))
    assert.ok(out.includes('\x1b[3m') && out.includes('48;5;22') && out.includes('48;5;52'))
    assert.ok(!records.some(frame => frame.overflow))
    assert.ok(!transcript.includes('◆ assistant'))
    const marker = (heading, color) => records.some(frame => frame.rawLines.some(line => strip(line).includes(heading) && line.includes('\x1b[' + color + 'm• ')))
    assert.ok(marker(shellHeading, 33), 'pending tool must have a yellow marker')
    assert.ok(marker('• Write demo.ts', 32) && marker('• Edit demo.ts', 32), 'completed file tools must have green markers')
    assert.ok(marker(shellHeading, decision === 'allow' ? 32 : 31), 'settled tool marker must reflect the Host outcome')
    assert.ok(!transcript.includes('✓ done'), 'completion uses the marker, with no extra status row')
    if (decision === 'allow') {
      assert.ok(transcript.includes('✓ You approved bash printf') && transcript.includes('this time'))
      assert.ok(JSON.stringify(served).includes('TOOL OUTPUT'))
    } else {
      assert.ok(transcript.includes('You rejected bash printf'))
      assert.ok(!transcript.includes('✓ You approved'))
    }
    if (preset === 'standard') {
      let offset = frames().length
      child.stdin.write('\x0f')
      await waitFor((_text, records) => records.slice(offset).some(frame => frame.lines.some(line => line.includes('18 total lines, ctrl+o to collapse'))), 'expand source')
      if (fullscreen) {
        for (let page = 0; page < 12 && !frames().slice(offset).some(frame => frame.lines.some(line => line.includes('source row 18'))); page += 1) {
          const count = frames().length
          child.stdin.write('\x1b[5~')
          await waitFor((_text, records) => records.length > count, 'browse expanded source')
        }
      }
      await waitFor((_text, records) => records.slice(offset).some(frame => frame.lines.some(line => line.includes('source row 18'))), 'expanded source visibility')
    }
    child.stdin.write('\x04')
    const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    console.log(label, 'PASS', 'frames', records.length, 'tools', served.length, 'shellExecuted', decision === 'allow')
  } catch (error) {
    child.kill('SIGTERM'); await closed
    console.error(label, 'stdout', strip(out).slice(-6000), 'stderr', err.slice(-3000))
    throw error
  }
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const fullscreen of [false, true]) for (const decision of ['allow', 'reject']) await run(fullscreen, decision)
  await run(false, 'allow', 'ptc', 'compact')
  await run(true, 'allow', 'ptc', 'detailed')
  console.log('RESULT PASS 6 configurations')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
