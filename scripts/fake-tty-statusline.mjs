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
const model = 'deepseek/deepseek-v4.1-flash'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    const title = body.includes('Create a concise title')
    if (!title && body.includes('probe turn failure')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Turn status failure probe', type: 'invalid_request_error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (choices, usage) => res.write('data: ' + JSON.stringify({
      id: 'statusline-probe', object: 'chat.completion.chunk', created: 1, model, choices, usage,
    }) + '\n\n')
    send([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
    if (!title && body.includes('probe turn cancellation')) return
    setTimeout(() => {
      send([{ index: 0, delta: { content: title ? 'Statusline probe' : 'STATUSLINE DONE' }, finish_reason: null }])
      send([{ index: 0, delta: {}, finish_reason: 'stop' }])
      send([], { prompt_tokens: 24_000, completion_tokens: 12, total_tokens: 24_012 })
      res.end('data: [DONE]\n\n')
    }, title ? 0 : 350)
  })
})

async function run(fullscreen, width, theme) {
  const label = (fullscreen ? 'fullscreen' : 'main-screen') + '-' + width + '-' + theme
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
    '        models:', '          - id: ' + model, '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: minimal', '    theme: auto', '    fullscreen: ' + fullscreen,
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: ' + model, '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'), MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    FAKE_TTY_COLUMNS: String(width), FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1',
  }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'),
    join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = '', reported = false, keyboardReported = false, colorTimer
  child.stdout.on('data', chunk => {
    out += chunk
    if (!keyboardReported && out.includes('\x1b[?u')) {
      keyboardReported = true
      child.stdin.write('\x1b[?1;2c')
    }
    if (!reported && out.includes('\x1b]11;?\x07')) {
      reported = true
      const reply = theme === 'light' ? '\x1b]10;rgb:1e1e/1e1e/1e1e\x07\x1b]11;rgb:ffff/ffff/ffff\x07'
        : '\x1b]10;rgb:ebeb/ebeb/ebeb\x07\x1b]11;rgb:2828/2a2a/3636\x07'
      colorTimer = setTimeout(() => child.stdin.write(reply + '\x1b[?1;2c'), theme === 'light' ? 250 : 0)
    }
  })
  child.stderr.on('data', chunk => { err += chunk })
  const closed = once(child, 'close')
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, phase) => {
    const deadline = Date.now() + 20_000
    while (!predicate(frames())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(label + ': ' + phase + ' failed')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  // The footer has to belong to the context card, not to any other card in the frame.
  const contextShowsDetails = frame => {
    const title = frame.lines.findIndex(line => line.includes('◇ context'))
    return title >= 0 && (frame.lines[title + 1] ?? '').trim() === 'Show details · ctrl+o'
  }
  try {
    const surface = theme === 'light' ? '48;2;244;244;244' : '48;2;65;67;78'
    await waitFor(records => records.some(frame => frame.rawLines.some(line => line.includes(surface)) && frame.status.includes('Ready')), 'terminal palette')
    const initial = frames().find(frame => frame.rawLines.some(line => line.includes(surface)) && frame.status.includes('Ready'))
    assert.ok(initial.lines.some(line => line.includes('Ask DeepSeek Harness to do anything')), 'empty editor shows its display-only hint')
    assert.ok(!/0 turns|0 steps|0 tok|— tok\/s|cache —/u.test(initial.status), 'empty usage does not crowd the status line')
    const readyColor = theme === 'light' ? '38;2;111;66;170' : '38;2;189;147;249'
    assert.ok(initial.rawLines.some(line => line.includes(readyColor + 'mReady')), 'Ready uses the violet state color')
    assert.ok(!initial.lines.some(line => line.includes('rgb:')), 'terminal replies never enter the draft')
    child.stdin.write('check statusline\r')
    await waitFor(records => records.some(frame => frame.status.includes('Working') && frame.wait), 'working')
    await waitFor(records => records.some(frame => frame.status.includes('Ready') && /(?:Context \d+% used|ctx \d+%)/u.test(frame.status)), 'settled context')
    await waitFor(records => records.some(frame => !frame.wait && frame.status.includes('Ready')
      && frame.lines.some(line => /^Worked for (?:\d+h )?(?:\d+m )?\d+s · \d{2}:\d{2}/u.test(line))), 'completion receipt')
    const prompt = initial.lines.findLastIndex(line => line.startsWith('› '))
    assert.ok(prompt > 0 && initial.rawLines[prompt].includes(surface), 'input uses a neutral surface')
    assert.equal(initial.lines[prompt - 1].trim(), ''); assert.equal(initial.lines[prompt + 1].trim(), '')
    assert.ok(!initial.lines.some(line => /^─+$/u.test(line)), 'chrome uses spacing instead of stacked rules')
    const bodyMarker = 'Current working directory:'
    assert.ok(frames().some(contextShowsDetails), 'context card carries the details footer')
    assert.ok(!frames().some(frame => frame.lines.some(line => line.includes(bodyMarker))), 'context body starts folded')
    let offset = frames().length
    child.stdin.write('\x0f')
    await waitFor(records => records.slice(offset).some(frame => frame.lines.some(line => line.includes(bodyMarker))), 'expand context')
    offset = frames().length
    child.stdin.write('\x0f')
    await waitFor(records => records.slice(offset).some(frame => contextShowsDetails(frame)
      && !frame.lines.some(line => line.includes(bodyMarker))), 'collapse context')
    let outcome = 'completed'
    if (width === 60) {
      offset = frames().length
      child.stdin.write('probe turn failure\r')
      await waitFor(records => records.slice(offset).some(frame => frame.status.includes('Ready') && !frame.wait
        && frame.lines.some(line => line.startsWith('Failed after '))), 'failure receipt')
      assert.ok(frames().at(-1).lines.some(line => line.includes('Turn failed:')), 'failure details remain visible')
      outcome = 'failed'
    } else if (fullscreen) {
      offset = frames().length
      child.stdin.write('probe turn cancellation\r')
      await waitFor(records => records.slice(offset).some(frame => frame.wait && frame.status.includes('Working')), 'cancellable wait')
      child.stdin.write('\x1b')
      await waitFor(records => records.slice(offset).some(frame => frame.status.includes('Ready') && !frame.wait
        && frame.lines.some(line => line.startsWith('Cancelled after '))), 'cancellation receipt')
      outcome = 'cancelled'
    }
    const records = frames()
    const ready = records.find(frame => frame.status.includes('Ready'))
    assert.match(ready.status, /(?:Context|ctx) —/u)
    const settled = records.at(-1)
    const accent = '\u001b[' + (theme === 'light' ? '38;5;25' : '38;5;117') + 'm'
    const accented = value => records.some(frame => frame.rawLines.some(line => line.includes(accent + value + '\u001b[39m')))
    const turns = records.map(frame => /(\d+) turns/u.exec(frame.status)).find(match => match !== null)
    const share = records.map(frame => /(?:Context \d+% used|ctx \d+%)/u.exec(frame.status)).find(match => match !== null)
    const throughput = records.map(frame => /[\d.]+ tok\/s/u.exec(frame.status)).find(match => match !== null)
    const cache = records.map(frame => /cache [\d.]+%/u.exec(frame.status)).find(match => match !== null)
    const preset = '\u001b[' + (theme === 'light' ? '38;5;91' : '38;5;141') + 'm'
    // Narrow layouts drop the counts before the state and context share.
    if (turns !== undefined) assert.ok(accented(turns[1] + ' turns'), 'turn counts use the accent color')
    assert.ok(share !== undefined && accented(share[0]), 'context field uses the accent color')
    if (throughput !== undefined) assert.ok(records.some(frame => frame.rawLines.some(line => line.includes('\u001b[32m' + throughput[0] + '\u001b[39m'))), 'throughput uses the success color')
    if (cache !== undefined) assert.ok(records.some(frame => frame.rawLines.some(line => line.includes(preset + cache[0] + '\u001b[39m'))), 'cache uses the preset color')
    assert.ok(records.every(frame => frame.statusRow === frame.editorRow + 2), 'status must follow the input panel')
    assert.ok(records.every(frame => !frame.overflow), 'no rendered row may exceed terminal width')
    assert.ok(records.every(frame => frame.footer.startsWith('off · ')), 'mode stays on the second status row')
    assert.ok(records.every(frame => frame.footer.includes('workspace-write')), 'native permissions must stay visible')
    assert.ok(records.every(frame => frame.status.includes('deepseek-v4.1-flash')), 'the long model name remains visible')
    assert.ok(records.some(frame => frame.footer.includes('esc cancel')), 'running shortcut remains visible')
    child.stdin.write('\x04')
    const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    assert.ok(out.includes('STATUSLINE DONE'))
    results.push({ label, frames: records.length, surface, lateReply: theme === 'light', outcome,
      receipt: settled.lines.findLast(line => /^(?:Worked for|Failed after|Cancelled after)/u.test(line))?.trimEnd(), status: settled.status, footer: settled.footer })
    console.log(label, 'PASS', JSON.stringify(results.at(-1)))
  } catch (error) {
    clearTimeout(colorTimer)
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
    for (const width of [160, 60]) await run(fullscreen, width, width === 60 ? 'light' : 'dark')
  }
  console.log('RESULT PASS', results.length, 'configurations')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
