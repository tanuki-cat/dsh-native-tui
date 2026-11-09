/** Real Host: upward slash menus, keyboard completion, subcommands and fullscreen mouse input. */
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
const menuRow = frame => frame.lines.findIndex(line => line.startsWith('› '))
const promptRow = frame => frame.lines.findLastIndex(line => line.startsWith('> '))

async function run(fullscreen, width) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-tui-completion-'))
  const profile = join(root, 'profiles/tui'), workspace = join(root, 'workspace'), log = join(root, 'frames.jsonl')
  const label = (fullscreen ? 'fullscreen' : 'main-screen') + '-' + width
  let requests = 0, child, closed, out = '', err = ''
  const server = createServer((_req, res) => { requests += 1; res.writeHead(500); res.end('Local commands must not call the model') })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    for (const dir of [join(profile, 'node_modules'), workspace, join(root, 'agents'), join(root, 'bundled')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{"private":true}')
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'completion-profile', private: true,
      dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } } }))
    symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
      '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
      '        models:', '          - id: completion-model', '            contextWindow: 128000', '            maxTokens: 4096',
      '- id: native-tui', '  config:', '    agentPreset: standard', '    theme: dark', '    fullscreen: ' + fullscreen,
      '- id: agent-default-model', '  config:', '    provider: mock', '    model: completion-model', '',
    ].join('\n'))
    const env = { ...process.env, DSH_HOME: root, DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'),
      MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_COLUMNS: String(width), FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1' }
    delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
    child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
    const frames = () => {
      if (!existsSync(log)) return []
      const text = readFileSync(log, 'utf8'), end = text.lastIndexOf('\n')
      return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line))
    }
    const waitFor = async (predicate, stage) => {
      const until = Date.now() + 20_000
      while (!predicate(frames().at(-1))) {
        if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage + ' failed')
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return frames().at(-1)
    }
    const draft = frame => frame?.lines[promptRow(frame)]?.trimEnd()
    const initial = await waitFor(frame => frame?.status.includes('Ready') && draft(frame) === '>', 'startup')
    const footerDistance = initial.lines.length - promptRow(initial)
    child.stdin.write('/')
    const menu = await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› /help'), 'command menu')
    assert.ok(menuRow(menu) < promptRow(menu), 'command menu must be above the input')
    assert.equal(menu.lines.length - promptRow(menu), footerDistance, 'input must stay beside the footer')
    assert.ok(menu.rawLines[menuRow(menu)].includes('\x1b[48;5;75;30m'), 'selection must use the full-row blue band')
    assert.equal(menu.lines.filter(line => /^(?:› | {2})\//u.test(line)).length, 8)
    if (width >= 80) assert.ok(menu.lines[menuRow(menu)].includes('show local and host commands'))
    if (fullscreen) assert.equal(menu.editorRow, initial.editorRow, 'fullscreen input must stay anchored')
    child.stdin.write('\x1b[B')
    await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› /new'), 'down arrow')
    child.stdin.write('\x1b[A')
    await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› /help'), 'up arrow')
    child.stdin.write('\t')
    await waitFor(frame => draft(frame) === '> /help' && menuRow(frame) < 0, 'Tab insertion')
    child.stdin.write('\r')
    await waitFor(frame => draft(frame) === '>' && frame.lines.some(line => line.includes('Host commands:')), 'help command')
    child.stdin.write('/he')
    await waitFor(frame => draft(frame) === '> /he' && frame.lines[menuRow(frame)]?.startsWith('› /help'), 'command filtering')
    child.stdin.write('\r')
    await waitFor(frame => draft(frame) === '>' && menuRow(frame) < 0, 'Enter selection')
    child.stdin.write('/provider ')
    await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› add'), 'subcommands')
    child.stdin.write('\x1b[B')
    await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› list'), 'subcommand selection')
    child.stdin.write('\t')
    await waitFor(frame => draft(frame) === '> /provider list', 'subcommand insertion')
    child.stdin.write('\r')
    await waitFor(frame => draft(frame) === '>' && frame.lines.some(line => line.includes('Configured third-party providers:')), 'provider list')
    child.stdin.write('/he')
    const filtered = await waitFor(frame => frame?.lines[menuRow(frame)]?.startsWith('› /help'), 'reopen menu')
    if (fullscreen) {
      const position = '4;' + (menuRow(filtered) + 1)
      child.stdin.write('\x1b[<0;' + position + 'M\x1b[<0;' + position + 'm')
      await waitFor(frame => draft(frame) === '> /help' && menuRow(frame) < 0, 'mouse completion')
    }
    child.stdin.write('\x1b')
    await waitFor(frame => draft(frame) === '>' && menuRow(frame) < 0, 'Escape clears draft')
    assert.ok(!frames().some(frame => frame.overflow), 'rows must stay within the terminal width')
    assert.equal(requests, 0, 'local command completion must not call the model')
    child.stdin.write('\x04')
    let deadline, exit
    try {
      exit = await Promise.race([closed, new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(label + ': shutdown timed out')), 20_000)
      })])
    } finally { clearTimeout(deadline) }
    const [code, signal] = exit
    assert.equal(signal, null); assert.equal(code, 0)
    console.log(label, 'PASS: upward menu; blue selection; keyboard; subcommands; footer anchor' + (fullscreen ? '; mouse' : ''))
  } catch (error) {
    console.error(label, 'stdout', stripTerminalSequences(out).slice(-4000), 'stderr', err.slice(-3000))
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

for (const fullscreen of [false, true]) for (const width of [100, 50]) await run(fullscreen, width)
console.log('RESULT PASS 4 configurations')
