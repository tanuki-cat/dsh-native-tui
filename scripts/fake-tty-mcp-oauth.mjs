import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const { DSH_CLI_ENTRY: cli, DSH_TUI_TGZ: bundle } = process.env
assert(cli && bundle, 'Set DSH_CLI_ENTRY and DSH_TUI_TGZ to the target CLI and packed TUI')
const home = await mkdtemp(join(repo, '.tmp/mcp-oauth-'))
const profile = join(home, 'profiles/tui')
const env = { ...process.env, DSH_HOME: home, DSH_NATIVE_TUI_NO_LAUNCHER: '1', MOCK_API_KEY: 'fixture',
  FAKE_TTY_COLUMNS: '600', FAKE_TTY_ROWS: '45', TERM: 'xterm-256color', PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' }
const tool = { name: 'ping', description: 'Return the fixture receipt', inputSchema: { type: 'object', properties: {} } }
let origin = ''
let tokenRequests = 0
let toolCalls = 0
const server = createServer((req, res) => {
  void reply(req, res).catch(error => { res.destroy(error) })
})

async function reply(req, res) {
  const url = new URL(req.url, origin)
  const json = value => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    json({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['tools'] })
    return
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    json({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'] })
    return
  }
  if (url.pathname === '/mcp' && req.headers.authorization !== 'Bearer fixture-grant') {
    res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource", scope="tools"' }).end()
    return
  }
  const raw = Buffer.concat(await Array.fromAsync(req)).toString()
  if (url.pathname === '/token') {
    const form = new URLSearchParams(raw)
    assert.equal(form.get('code'), 'fixture-code')
    assert(form.get('code_verifier'))
    tokenRequests++
    json({ access_token: 'fixture-grant', token_type: 'Bearer', expires_in: 3600, scope: 'tools' })
    return
  }
  if (url.pathname === '/mcp' && req.method === 'POST') {
    const request = JSON.parse(raw)
    if (request.id === undefined) { res.writeHead(202).end(); return }
    const rpc = result => json({ jsonrpc: '2.0', id: request.id, result })
    switch (request.method) {
      case 'initialize': rpc({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'oauth-fixture', version: '1.0.0' } }); return
      case 'tools/list': rpc({ tools: [tool] }); return
      case 'tools/call': toolCalls++; rpc({ content: [{ type: 'text', text: 'OAUTH_TOOL_OK' }] }); return
    }
  }
  if (url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(raw)
    const messages = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1)
    const title = raw.includes('Create a concise title')
    const matched = messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('OAUTH_TOOL_OK'))
    const call = !title && !matched
    const delta = call ? { tool_calls: [{ index: 0, id: 'oauth-call', type: 'function',
      function: { name: 'mcp__demo__ping', arguments: '{}' } }] } : { content: title ? 'OAuth probe' : 'OAUTH_ROUNDTRIP_OK' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason) => res.write('data: ' + JSON.stringify({ id: 'oauth-fixture',
      object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    send({ role: 'assistant', ...delta }, null)
    send({}, call ? 'tool_calls' : 'stop')
    res.end('data: [DONE]\n\n')
    return
  }
  res.writeHead(404).end()
}

let child
let closed
let out = '', err = ''
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = 'http://127.0.0.1:' + server.address().port
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'oauth-probe', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  await promisify(execFile)(process.execPath, [cli, 'plugin', '--profile', 'tui', 'add', resolve(bundle)], { env, timeout: 180_000 })
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: mcp-oauth-webserver
  disabled: false
- id: native-tui
  config: { agentPreset: standard, theme: plain }
- id: llm-pi-ai
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: ${origin}/v1
        apiKeyEnv: MOCK_API_KEY
        models: [{ id: probe, contextWindow: 128000, maxTokens: 4096 }]
- id: agent-default-model
  config: { provider: mock, model: probe }
`)
  child = spawn(process.execPath, [join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
    { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  closed = once(child, 'close')
  child.stdout.on('data', value => { out += value })
  child.stderr.on('data', value => { err += value })
  const step = async (pattern, keys) => {
    const offset = keys === undefined ? 0 : out.length
    if (keys !== undefined) child.stdin.write(keys)
    const deadline = Date.now() + 15_000
    for (;;) {
      const match = pattern.exec(stripTerminalSequences(out.slice(offset)))
      if (match) return match
      assert(child.exitCode === null && Date.now() < deadline, 'Waiting for ' + pattern)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await step(/enter send/u)
  await step(/MCP server name/u, '/mcp add\r')
  await step(/MCP transport/u, 'demo\r')
  await step(/MCP endpoint URL/u, '\x1b[B\r')
  await step(/MCP authentication/u, origin + '/mcp\r')
  await step(/MCP headers JSON/u, '\x1b[B\r')
  await step(/MCP OAuth client ID/u, '\r')
  await step(/MCP OAuth scope/u, 'fixture-client\r')
  await step(/waiting-authorization/u, '\r')
  await step(/waiting for authorization/u, '/mcp list\r')
  const link = await step(/Copy into your browser: (https?:\/\/[^\s]+)/u, '/mcp auth demo\r')
  const authorization = new URL(link[1])
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', authorization.searchParams.get('state'))
  callback.searchParams.set('code', 'fixture-code')
  const response = await fetch(callback)
  assert.equal(response.status, 200)
  await response.text()
  await step(/MCP OAuth demo · authorized/u)
  await step(/connected · 1 tools/u, '/mcp list\r')
  await step(/Copy into your browser:/u, '/mcp auth demo\r')
  await step(/MCP OAuth demo · cancelled/u, '\x1b')
  await step(/OAUTH_ROUNDTRIP_OK/u, 'Call the OAuth fixture tool.\r')
  await step(/Sign out of MCP server demo\?/u, '/mcp signout demo\r')
  await step(/Signed out of MCP server demo\./u, '\x1b[B\r')
  await step(/waiting for authorization/u, '/mcp list\r')
  child.stdin.write('\x04')
  assert.deepEqual(await closed, [0, null])
  assert.equal(tokenRequests, 1)
  assert.equal(toolCalls, 1)
  console.log('PASS OAuth add, callback, granted tool call, cancelled reauthorization, signout · ' + home)
} finally {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await closed
  }
  await writeFile(join(home, 'terminal.txt'), stripTerminalSequences(out) + '\n' + err)
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
