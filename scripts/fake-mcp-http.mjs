/**
 * Fake Streamable HTTP MCP server for reconnect probes.
 *
 * Serves just enough of the MCP handshake for the official client to connect
 * and register `mcp__demo__echo`: `initialize`, `tools/list`, `tools/call`.
 * Like a real supergateway-backed server it answers JSON-RPC over POST and
 * keeps the session id in a response header. The probe kills and restarts it to
 * reproduce a server-side restart.
 *
 * Usage: node scripts/fake-mcp-http.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 0)
const tools = [{
  name: 'echo',
  description: 'Echo the provided text back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo' } },
    required: ['text'],
  },
}]

const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    let message
    try { message = JSON.parse(body) } catch {
      response.writeHead(400).end('bad request')
      return
    }
    const reply = (result) => {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    const refuse = (code, text) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: text } }))
    }
    if (message.method === 'initialize') {
      reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-http', version: '1.0.0' },
      })
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }
    if (message.method === 'tools/list') { reply({ tools }); return }
    if (message.method === 'tools/call') {
      if (message.params?.name !== 'echo') { refuse(-32602, 'unknown tool: ' + String(message.params?.name)); return }
      const text = String(message.params?.arguments?.text ?? '')
      reply({ content: [{ type: 'text', text: 'echo:' + text }], structuredContent: { echoed: text } })
      return
    }
    if (message.method === 'ping') { reply({}); return }
    refuse(-32601, 'method not found')
  })
})

const session = 'fake-session-' + process.pid
server.listen(port, '127.0.0.1', () => {
  // The probe reads this line to learn the chosen ephemeral port.
  console.log('LISTENING ' + server.address().port)
})
