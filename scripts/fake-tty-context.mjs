/**
 * Real-Host check for `/context`: occupancy figures plus the composition legend.
 *
 * A mock Responses provider streams one turn with a token-meter-visible system
 * prompt, a tool schema, and a user message, then reports usage so the pressure
 * projection has a provider sample to anchor to. The probe drives `/context`
 * and asserts the TUI prints the occupancy line, the bar, and the three legend
 * rows — including a bucket too small for a whole percent, which the Web panel
 * shows as a small figure rather than as 0%.
 *
 * Self-contained: it creates its own disposable home under /tmp. Run:
 *   pnpm build
 *   node scripts/fake-tty-context.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME ?? '/tmp/dsh-native-tui-context-home'
if (!home.startsWith('/tmp/dsh-native-tui-')) {
  console.error('Refusing to rewrite a profile outside a disposable /tmp/dsh-native-tui-* home: ' + home)
  process.exit(2)
}
const profile = join(home, 'profiles', 'tui')
const template = join(repo, '.tmp', 'context-home-template')

/**
 * Materialize the disposable profile from the repo's bundle patch layers, so the
 * probe never depends on a home some earlier probe happened to leave behind.
 */
function prepareProfile() {
  if (existsSync(join(profile, 'package.json'))) return
  if (existsSync(template)) {
    cpSync(template, home, { recursive: true })
    return
  }
  console.error('No TUI profile at ' + home + '; create one with:')
  console.error('  pnpm build && pnpm pack --pack-destination .tmp')
  console.error('  DSH_HOME=' + home + ' dsh plugin --profile tui add .tmp/dsh-native-tui-*.tgz')
  process.exit(2)
}
prepareProfile()

/** One SSE event in the Responses wire format. */
const event = (type, payload = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n'

/**
 * Stream one turn: a short answer plus usage, which is all the probe needs — the
 * composition comes from the surface the request itself carried.
 */
function serveTurn(body, res) {
  const isTitle = body.includes('Create a concise title')
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const payload = isTitle ? 'Context probe' : 'CONTEXT-PROBE-ANSWER'
  res.write(event('response.created', { response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] } }))
  res.write(event('response.output_item.added', { output_index: 0, item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }))
  res.write(event('response.output_text.delta', { output_index: 0, delta: payload }))
  res.write(event('response.output_item.done', {
    output_index: 0,
    item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: payload, annotations: [] }] },
  }))
  res.write(event('response.completed', {
    response: {
      id: 'resp_probe',
      status: 'completed',
      // Prompt-side usage is what the pressure projection anchors to; the tool
      // schema in the request is what the composition prices separately.
      usage: { input_tokens: 24_000, output_tokens: 12, total_tokens: 24_012 },
      output: [],
    },
  }))
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model' }] }))
    return
  }
  if (req.url === '/v1/responses' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => { serveTurn(body, res) })
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const contextWindow = 128_000
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: openai-responses
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: ${contextWindow}
            maxTokens: 4096
- id: native-tui
  name: dsh-native-tui
  config:
    thinkingDisplay: compact
`)

const child = spawn(process.execPath, [join(repo, 'scripts', 'fake-tty-entry.mjs'), '--profile', 'tui'], {
  cwd: repo,
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '130', LINES: '44', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', data => { out += String(data) })
child.stderr.on('data', data => { err += String(data) })
// Drop CSI styling and OSC-8 hyperlinks (which pi-tui leaves as bare `]8;;`),
// so the captured legend lines keep their real column alignment.
const strip = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\]8;;/g, '')
let phase = 'editor'
let sentContext = false
const started = Date.now()
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 'editor' && text.includes('enter send')) {
    phase = 'model'
    try { child.stdin.write('/model mock/mock-model\r') } catch {}
  }
  else if (phase === 'model' && text.includes('Model selected: mock/mock-model')) {
    phase = 'prompt'
    try { child.stdin.write('probe context composition\r') } catch {}
  }
  else if (phase === 'prompt' && text.includes('CONTEXT-PROBE-ANSWER')) {
    phase = 'report'
    setTimeout(() => { try { child.stdin.write('/context\r') } catch {} }, 500)
  }
  else if (phase === 'report' && !sentContext && text.includes('Context used:')) {
    sentContext = true
    setTimeout(() => { try { child.stdin.write('\x04') } catch {} }, 500)
  }
}, 60)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 25_000)
child.on('exit', (code, signal) => {
  clearInterval(tick)
  clearTimeout(hard)
  const text = strip(out)
  const report = text.slice(text.lastIndexOf('Context used:') - 200)
  // The bar spans the model window, so only its filled part is used occupancy
  // and the fill length must equal the percentage the headline states.
  const barLine = report.split('\n').find(line => /[█▓▒░]{8,}/.test(line)) ?? ''
  const bar = barLine.trim()
  const filledCells = [...bar].filter(cell => cell !== '░').length
  const headlinePercent = Number(/Context used: (\d+)%/.exec(report)?.[1] ?? -1)
  const expectedCells = Math.round(headlinePercent / 100 * 40)
  const checks = {
    // The occupancy line states a percentage and the window it divides by.
    occupancy: /Context used: \d+%  ·  ~[\d.]+[KM] \/ 128K/.test(text),
    // A provider sample exists, so the meter is not silent.
    noSilence: !text.includes('Waiting for the first provider usage sample'),
    // The composition is drawn, not reported as unmounted.
    composition: report.includes('system prompt') && report.includes('tool definitions') && report.includes('messages'),
    // Fill states the occupancy rather than painting the whole track.
    barMatchesOccupancy: headlinePercent > 0 && [...bar].length === 40 && filledCells === expectedCells,
    // Percent shares are printed with a decimal, so a sub-1% bucket is not 0%.
    shares: /\d+\.\d%/.test(report),
    // The buckets now sum to the occupancy itself, so the split cannot claim
    // more context than the session is billed for.
    bucketsSumToOccupancy: (() => {
      /** Parse one rendered count such as `~20.8K` or `20.8K` into tokens. */
      const parseCount = (text) => {
        const raw = /([\d.]+)([KM]?)/.exec(text)
        if (raw === null) return undefined
        const value = Number(raw[1])
        if (!Number.isFinite(value)) return undefined
        return raw[2] === 'M' ? value * 1_000_000 : raw[2] === 'K' ? value * 1_000 : value
      }
      // The legend rows are the only lines starting with a bucket glyph.
      // Rows are right-padded with spaces up to the terminal width and may end
      // in a carriage return from the paint, so trim before measuring.
      const rows = report.split('\n')
        .filter(line => /^\s*[█▓▒] /.test(line))
        .map(line => line.trim())
      if (rows.length !== 3) return false
      // Each legend row ends with its amount, so the trailing count wins.
      const total = rows.reduce((sum, row) => sum + (parseCount(row.split('~').pop() ?? '') ?? Number.NaN), 0)
      // The repaint stream mixes newlines and carriage returns, so read the
      // occupancy straight off the headline rather than splitting the capture.
      const occupancyTokens = parseCount(/Context used: \d+%  ·  (~[\d.]+[KM]?) \//.exec(text)?.[1] ?? '')
      if (!Number.isFinite(total) || occupancyTokens === undefined || occupancyTokens === 0) return false
      // Rounded display figures, so allow a couple of percent of slack.
      return Math.abs(total - occupancyTokens) / occupancyTokens < 0.02
    })(),
    // One split total, stated as the occupancy, never as a rival figure.
    noCompetingTotal: (report.match(/Shares split the/g) ?? []).length === 1,
    caveat: report.includes('Reasoning the request does not replay is left out'),
    // The buckets share one glyph and are told apart by colour alone, so each
    // hue has to reach the terminal (system grey, tools violet, messages blue).
    bucketColors: ['245', '141', '39'].every(code => out.includes('\u001B[38;5;' + code + 'm')),
  }
  const pass = code === 0 && signal === null && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'elapsed', Date.now() - started)
  console.log('checks', JSON.stringify(checks))
  console.log('bar filled', filledCells, '/', [...bar].length, 'headline', headlinePercent + '%', 'expected', expectedCells)
  const legendRows = report.split('\n').filter(line => /^\s*[█▓▒] /.test(line)).map(row => row.trim())
  console.log('legend', JSON.stringify(legendRows.map(row => row.split('~').pop())))
  console.log('RESULT', pass ? 'PASS' : 'FAIL')
  console.log('--- report ---')
  console.log(report.slice(0, 1600))
  if (!pass) {
    console.log('--- stdout tail ---')
    console.log(text.slice(-8000))
    console.log('--- stderr ---')
    console.log(err.slice(-3000))
  }
  server.close()
  process.exit(pass ? 0 : 1)
})
