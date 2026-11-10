/** Real Host: /context bucket colors and occupancy reach main-screen and fullscreen frames. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'native-context-colors-'))
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    const text = raw.includes('Create a concise title') ? 'Context probe' : 'CONTEXT COLOR PROBE DONE'
    const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.created', { response: { id: 'context-probe', status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.output_text.delta', { output_index: 0, delta: text })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: { id: 'context-probe', status: 'completed', output: [item], usage: { input_tokens: 24000, output_tokens: 12, total_tokens: 24012 } } })
    res.end('data: [DONE]\n\n')
  })
})

async function run(fullscreen, theme, columns) {
  const label = [fullscreen ? 'fullscreen' : 'main-screen', theme, columns].join('-')
  const home = join(root, label), profile = join(home, 'profiles/tui'), workspace = join(home, 'workspace'), log = join(home, 'frames.jsonl')
  for (const dir of [join(profile, 'node_modules'), workspace, join(home, 'agents'), join(home, 'bundled')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workspace, 'package.json'), '{"private":true}')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'context-colors-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: context-model', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: standard', '    fullscreen: ' + fullscreen, '    theme: ' + theme,
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: context-model', '',
  ].join('\n'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
    DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'),
    MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: String(columns), FAKE_TTY_ROWS: '42',
    FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
    { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, stage) => {
    const until = Date.now() + 20000
    while (!predicate()) {
      if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage + ' failed')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  try {
    await waitFor(() => stripTerminalSequences(out).includes('enter send'), 'startup')
    child.stdin.write('probe context composition\r')
    await waitFor(() => frames().some(frame => frame.status.includes('Ready') && frame.lines.some(line => line.includes('CONTEXT COLOR PROBE DONE'))), 'usage sample')
    child.stdin.write('/context\r')
    const reportFrame = frame => frame.lines.some(line => line.includes('Context used:')) && frame.lines.some(line => line.includes('tool definitions'))
    await waitFor(() => frames().some(reportFrame), 'context report')
    const records = frames(), frame = records.find(reportFrame)
    const barRaw = frame.rawLines.find(line => /[█░]{8,}/u.test(stripTerminalSequences(line)))
    assert.ok(barRaw, 'composition bar is visible')
    const bar = stripTerminalSequences(barRaw).trim()
    const percent = Number(/Context used: (\d+)%/u.exec(frame.lines.join('\n'))?.[1])
    const filled = [...bar].filter(char => char === '█').length
    assert.equal(bar.length, 40)
    assert.equal(filled, Math.round(percent / 100 * 40), 'fill matches reported window occupancy')
    const legend = ['system prompt', 'tool definitions', 'messages'].map(label => frame.rawLines.find(line => line.includes(label)))
    assert.ok(legend.every(Boolean), 'all legend rows are visible')
    const codes = theme === 'light' ? [243, 98, 25] : [245, 141, 39]
    if (theme === 'plain') {
      assert.ok([barRaw, ...legend].every(line => !/\x1b\[38;/u.test(line)), 'plain report has no foreground colors')
    } else {
      let coloredFill = 0
      for (const [index, code] of codes.entries()) {
        const segment = new RegExp('\\x1b\\[38;5;' + code + 'm(█+)').exec(barRaw)
        assert.ok(segment, 'bar includes bucket color ' + code)
        coloredFill += segment[1].length
        assert.ok(legend[index].includes('\x1b[38;5;' + code + 'm█'), 'legend matches bucket color ' + code)
      }
      assert.equal(coloredFill, filled)
    }
    const count = value => {
      const match = /~([\d.]+)([KM]?)/u.exec(value)
      return match ? Number(match[1]) * (match[2] === 'M' ? 1000000 : match[2] === 'K' ? 1000 : 1) : Number.NaN
    }
    const total = legend.map(line => count(stripTerminalSequences(line))).reduce((sum, value) => sum + value, 0)
    const headline = frame.lines.find(line => line.includes('Context used:'))
    assert.match(headline, /Context used: \d+%  ·  ~[\d.]+[KM] \/ 128K/u, 'headline retains occupancy and configured window')
    assert.ok(Math.abs(total - count(headline)) / count(headline) < 0.02, 'rounded composition sums to occupancy')
    assert.ok(legend.every(line => /\d+\.\d%/u.test(line)), 'shares retain fractional percentages')
    assert.equal(new Set(legend.map(line => stripTerminalSequences(line).indexOf('%'))).size, 1, 'legend percentage columns stay aligned')
    const reportText = frame.lines.map(line => line.trim()).join(' ').replace(/\s+/gu, ' ')
    assert.ok(!reportText.includes('Waiting for the first provider usage sample'))
    assert.ok(!reportText.includes('Composition: unknown'))
    assert.equal((reportText.match(/Shares split the/gu) ?? []).length, 1, 'report states one rebased split total')
    assert.ok(reportText.includes('Reasoning the request does not replay is left out'), 'report retains the rebasing explanation')
    assert.ok(!records.some(frame => frame.overflow), 'all rows fit')
    child.stdin.write('\x04')
    let deadline
    const exit = await Promise.race([closed, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(label + ': shutdown timed out')), 20000)
    })]).finally(() => { clearTimeout(deadline) })
    assert.equal(exit[1], null); assert.equal(exit[0], 0)
    console.log(label, 'PASS', JSON.stringify({ filled, percent, bucketColors: theme === 'plain' ? 'none' : codes, compositionMatchesOccupancy: true, overflow: false }))
  } catch (error) {
    console.error(label, stripTerminalSequences(out).slice(-5000), err.slice(-2000))
    throw error
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(force) }
    }
  }
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const fullscreen of [false, true]) for (const [theme, columns] of [['dark', 100], ['light', 50], ['plain', 80]]) await run(fullscreen, theme, columns)
  console.log('RESULT PASS 6 configurations')
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
