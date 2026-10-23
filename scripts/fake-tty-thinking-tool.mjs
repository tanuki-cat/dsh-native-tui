import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Probes the reasoning placeholder while a tool call streams.
 *
 * pi-ai's Anthropic path opens a `thinking` content block on every
 * `content_block_start`, even when the block carries no text and no delta ever
 * follows. A step that then dispatches a tool kept rendering `thinking …`
 * over the running tool: the reasoning block never produced content, so
 * `starting` was never cleared.
 */
mkdirSync('.tmp', { recursive: true })
const workspace = mkdtempSync('.tmp/thinking-tool-')
const home = mkdtempSync(join(tmpdir(), 'dsh-native-tui-thinking-tool-'))
mkdirSync(home + '/profiles/tui', { recursive: true })

const sse = (res, event, data) => {
  res.write('event: ' + event + '\n')
  res.write('data: ' + JSON.stringify(data) + '\n\n')
}

const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'mock-model', context_length: 128000, max_tokens: 4096 }] }))
    return
  }
  const isMessages = req.url?.includes('/messages') === true
  if (isMessages && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      const isTitle = body.includes('Create a concise title')
      const done = (body.match(/"type":"tool_result"/g) ?? []).length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      sse(res, 'message_start', {
        type: 'message_start',
        message: { id: 'msg_thinking_tool', type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      })
      if (isTitle) {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking tool E2E' } })
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      if (done === 0) {
        // The bug's shape: an empty thinking block opens and never streams a
        // delta, then the tool_use block arrives in the same step.
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        setTimeout(() => {
          sse(res, 'content_block_start', {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call-thinking-tool', name: 'bash', input: {} },
          })
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'Thinking tool probe', command: 'echo THINKING-TOOL-OK' }) },
          })
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
          sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
          sse(res, 'message_stop', { type: 'message_stop' })
          res.end()
        }, 1500)
        return
      }
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'THINKING TOOL DONE' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })
    return
  }
  res.writeHead(404); res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
writeFileSync(home + '/profiles/tui/cordis.yml', '# dsh profile root\n[]\n')
writeFileSync(home + '/profiles/tui/package.json', JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
}, null, 2) + '\n')
writeFileSync(home + '/profiles/tui/cordis.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: anthropic-messages
        baseURL: http://127.0.0.1:${port}
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: standard
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`)
mkdirSync(home + '/profiles/tui/node_modules', { recursive: true })
try { symlinkSync(process.cwd(), home + '/profiles/tui/node_modules/dsh-native-tui', 'dir') }
catch (error) { if (error?.code !== 'EEXIST') throw error }
// The session runs in the probe workspace, so the entry script needs an
// absolute path: a relative one resolves against that cwd.
const entry = join(process.cwd(), 'scripts/fake-tty-entry.mjs')
const child = spawn(process.execPath, [entry, '--profile', 'tui'], {
  cwd: workspace,
  env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'dummy', COLUMNS: '130', LINES: '50', TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_NATIVE_TUI_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
let errOut = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { errOut += String(d) })
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
let phase = 0
let seenAt = 0
// Frames sampled while the tool call is in flight: after the empty thinking
// block opened and before the tool result landed.
const frames = []
const tick = setInterval(() => {
  const text = strip(out)
  if (phase === 0 && text.includes('enter send')) {
    phase = 1
    try { child.stdin.write('thinking tool probe\r') } catch {}
  }
  else if (phase === 1) {
    frames.push(text)
    if (text.includes('THINKING TOOL DONE')) {
      phase = 2
      seenAt = Date.now()
    }
  }
  else if (phase === 2 && Date.now() - seenAt > 800) {
    phase = 3
    try { child.stdin.write('\x04') } catch {}
  }
}, 120)
const hard = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 40000)
child.on('exit', (code, signal) => {
  clearInterval(tick); clearTimeout(hard); server.close()
  // The stream accumulates everything ever painted, so presence alone proves
  // nothing: the placeholder legitimately shows while the reasoning block is
  // open and nothing has streamed. The bug is the row SURVIVING the tool call,
  // so the check is positional — no `thinking …` may be painted after the tool
  // card that replaced it.
  const final = strip(out)
  const lastTool = final.lastIndexOf('⚙ bash')
  const afterTool = lastTool === -1 ? '' : final.slice(lastTool)
  const placeholderWithTool = afterTool.includes('thinking …') ? [final] : []
  // The chunk order is the premise the fix rests on: a reasoning block opens
  // with no delta, then the tool call arrives. Recording it keeps the probe
  // honest about what it actually reproduced.
  const events = errOut.split('\n').filter(line => line.includes('stream chunk:'))
      .map(line => line.slice(line.indexOf('stream chunk:') + 'stream chunk:'.length).trim())
  // The placeholder window is one chunk wide (~one frame), so a sample-based
  // probe cannot prove its absence; the unit spec covers that transition.
  const reasoningBeforeTool = events.findIndex(event => event.startsWith('block-start reasoning')) !== -1
    && events.findIndex(event => event.startsWith('block-start tool-call'))
      > events.findIndex(event => event.startsWith('block-start reasoning'))
  const checks = {
    'tool card rendered': lastTool !== -1,
    'assistant reply': final.includes('THINKING TOOL DONE'),
    'reasoning block opened before the tool call': reasoningBeforeTool,
    'no thinking placeholder beside the tool card': placeholderWithTool.length === 0,
  }
  const pass = code === 0 && signal === null && phase === 3 && Object.values(checks).every(Boolean)
  console.log('EXIT', code, signal, 'phase', phase, 'pass', pass)
  console.log(JSON.stringify(checks, null, 2))
  if (!pass) {
    console.log('--- a frame with both ---')
    console.log(placeholderWithTool[0]?.slice(-1600) ?? '(none)')
    console.log('--- stderr tail ---')
    console.log(errOut.slice(-1200))
  }
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
})
