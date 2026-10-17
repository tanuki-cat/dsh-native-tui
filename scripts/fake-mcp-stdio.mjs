import { stdin, stdout } from 'node:process'

/** One placeholder tool so a client can exercise the full tools/list + tools/call path. */
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
]

const send = (message) => { stdout.write(JSON.stringify(message) + '\n') }
let buffer = ''
stdin.setEncoding('utf8')
stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'native-tui-test', version: '1.0.0' },
      } })
    }
    else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    }
    else if (message.method === 'tools/call') {
      if (message.params?.name !== 'echo') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool: ' + String(message.params?.name) } })
        continue
      }
      const text = String(message.params?.arguments?.text ?? '')
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: 'echo:' + text }],
        structuredContent: { echoed: text },
      } })
    }
    else if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    }
    else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
    }
  }
})
