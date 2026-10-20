import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const NL = String.fromCharCode(10).repeat(2)
const home = '/tmp/dsh-native-tui-stream-smooth-home'
rmSync(home, { recursive: true, force: true })
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
const answer = 'smooth-' + 'x'.repeat(200) + '-done'

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = payload => res.write('data: ' + JSON.stringify(payload) + NL)
      send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })
      send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]' + NL)
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root' + String.fromCharCode(10) + '[]' + String.fromCharCode(10))
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + String.fromCharCode(10))
writeFileSync(home + '/profiles/tui/cordis.patch.yml', [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      mock:',
  '        api: openai-completions',
  `        baseURL: http://127.0.0.1:${String(port)}/v1`,
  '        apiKeyEnv: MOCK_API_KEY',
  '        models:',
  '          - id: mock-model',
  '            name: mock-model',
  '            contextWindow: 128000',
  '            maxTokens: 4096',
  '- id: native-tui',
  '  name: dsh-native-tui',
  '  config:',
  '    agentPreset: standard',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: mock',
  '    model: mock-model',
].join(String.fromCharCode(10)) + String.fromCharCode(10))
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }

const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let out = '', err = '', sent = false, exitSent = false
child.stdout.on('data', data => {
  out += String(data)
  const text = strip(out)
  if (!sent && text.includes('enter send')) {
    sent = true
    child.stdin.write('hi' + String.fromCharCode(13))
    return
  }
  if (sent && !exitSent && text.includes('-done')) {
    exitSent = true
    setTimeout(() => { try { child.stdin.write(String.fromCharCode(4)) } catch {} }, 900)
  }
})
child.stderr.on('data', data => { err += String(data) })
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25000)
child.on('exit', (code, signal) => {
  clearTimeout(hard)
  server.close()
  const clean = strip(out)
  const chunkLog = err.includes('stream chunk: text-delta 212 chars')
  const revealLines = err.split(String.fromCharCode(10)).filter(line => line.includes('reveal text:'))
  const firstAdvance = Number(revealLines[0]?.match(/advance=(\d+)/)?.[1] ?? NaN)
  const finalVisible = clean.includes('smooth-') && clean.includes('-done')
  const pass = code === 0 && chunkLog && finalVisible && revealLines.length > 1 && firstAdvance <= 24
  console.log('EXIT', code, signal, 'sent', sent, 'chunkLog', chunkLog, 'revealLines', revealLines.length, 'firstAdvance', firstAdvance, 'finalVisible', finalVisible, 'pass', pass)
  console.log(revealLines.slice(0, 6).join(String.fromCharCode(10)))
  console.log('--- STDERR tail ---')
  console.log(err.slice(-1500))
  process.exit(pass ? 0 : 1)
})
